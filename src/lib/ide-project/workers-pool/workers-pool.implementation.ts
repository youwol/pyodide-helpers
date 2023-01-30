import { EnvironmentState, ExecutingImplementation } from '../environment.state'
import { IdeState, RawLog, WorkerCommon } from '../models'
import { BehaviorSubject, Observable, Subject } from 'rxjs'
import { filter, map, mergeMap, skip, take, tap } from 'rxjs/operators'
import {
    EntryPointArguments,
    MessageDataExit,
    WorkersFactory,
} from './workers-factory'
import {
    dispatchWorkerMessage,
    initializeWorkersPool,
    objectPyToJs,
} from './utils'
import { Context } from '../context'
import { patchPythonSrc, WorkerListener } from '../in-worker-executable'
import {
    CdnEvent,
    InstallDoneEvent,
    InstallLoadingGraphInputs,
} from '@youwol/cdn-client'
import { PyodideSetup } from '../../pyodide-setup'

interface EntryPointSyncFsMapArgs {
    exportedPyodideInstanceName: string
    exportedRxjsSymbol: string
}

export function entryRegisterPyPlayAddOns(
    input: EntryPointArguments<EntryPointSyncFsMapArgs>,
) {
    const pyodide = self[input.args.exportedPyodideInstanceName]
    const registerYwPyodideModule = self['registerYwPyodideModule']

    const outputs = {
        onLog: (log) => {
            self['getPythonChannel$']().next({ type: 'PythonStdOut', log })
        },
        onView: (view) => {
            self['getPythonChannel$']().next({ type: 'PythonViewOut', view })
        },
        onData: (data) => {
            self['getPythonChannel$']().next({ type: 'WorkerData', data })
        },
    }

    pyodide.registerJsModule('python_playground', {
        worker_thread: {
            Emitter: {
                send: (d: unknown) => {
                    outputs.onData(d)
                },
            },
        },
    })

    return Promise.all([registerYwPyodideModule(pyodide, outputs)])
}

interface EntryPointExeArgs {
    content: string
    fileSystem: Map<string, string>
    exportedPyodideInstanceName: string
    pythonGlobals: Record<string, unknown>
}

async function entryPointExe(input: EntryPointArguments<EntryPointExeArgs>) {
    const pyodide = self[input.args.exportedPyodideInstanceName]
    const pythonChannel$ = new self['rxjs_APIv6'].ReplaySubject(1)
    self['getPythonChannel$'] = () => pythonChannel$
    const syncFileSystem = self['syncFileSystem']
    const registerJsModules = self['registerJsModules']
    const cleanFileSystem = self['cleanFileSystem']
    const cleanJsModules = self['cleanJsModules']
    const objectPyToJs = self['objectPyToJs']
    await Promise.all([
        syncFileSystem(pyodide, input.args.fileSystem),
        registerJsModules(pyodide, input.args.fileSystem),
    ])
    const sub = pythonChannel$.subscribe((message) => {
        input.context.sendData(objectPyToJs(pyodide, message))
    })
    const namespace = pyodide.toPy(input.args.pythonGlobals)
    let result = undefined
    try {
        result = await pyodide.runPythonAsync(input.args.content, {
            globals: namespace,
        })
    } catch (e) {
        result = e
    }

    sub.unsubscribe()
    return await Promise.all([
        cleanFileSystem(pyodide, input.args.fileSystem),
        cleanJsModules(pyodide, input.args.fileSystem),
    ]).then(() => {
        if (result instanceof Error) {
            throw result
        }
        return objectPyToJs(pyodide, result)
    })
}

/**
 * @category State
 */
export class WorkersPoolImplementation implements ExecutingImplementation {
    /**
     * @group Immutable Constants
     */
    public readonly name: string

    /**
     * @group Observables
     */
    public readonly workersFactory$ = new BehaviorSubject<WorkersFactory>(
        undefined,
    )

    /**
     * @group Observables
     */
    public readonly busyWorkers$ = new BehaviorSubject<string[]>([])

    /**
     * @group Observable
     */
    public readonly capacity$: BehaviorSubject<number>

    /**
     * @group Observable
     */
    public readonly signals: {
        install$: Observable<number>
        save$: Observable<unknown>
    }

    constructor({ capacity, name }: { capacity: number; name: string }) {
        this.capacity$ = new BehaviorSubject<number>(capacity)
        this.name = name
        this.signals = {
            install$: this.capacity$.pipe(skip(1)),
            save$: this.capacity$,
        }
    }

    serialize(model: WorkerCommon) {
        return {
            ...model,
            capacity: this.capacity$.value,
        }
    }

    installRequirements(
        lockFile: InstallLoadingGraphInputs,
        rawLog$: Subject<RawLog>,
        cdnEvent$: Subject<CdnEvent>,
    ) {
        this.workersFactory$.value && this.workersFactory$.value.terminate()
        this.workersFactory$.next(undefined)
        // Propagation of the CDN events are handled by the workers factory.
        // It is not possible to pass functions to the worker anyway.
        lockFile.customInstallers.forEach((installer) => {
            installer.installInputs['onEvent'] = undefined
        })

        const { workersFactory, channels } = initializeWorkersPool(
            lockFile,
            this.capacity$.value,
            cdnEvent$,
        )

        workersFactory.busyWorkers$.subscribe((workers) => {
            this.busyWorkers$.next(workers)
        })
        return channels.pipe(
            tap(() => {
                this.workersFactory$.next(workersFactory)
                cdnEvent$.next(new InstallDoneEvent())
            }),
        )
    }

    execPythonCode(
        code: string,
        fileSystem: Map<string, string>,
        rawLog$: Subject<RawLog>,
        pythonGlobals: Record<string, unknown>,
        options: {
            workerListener?: WorkerListener
            targetWorkerId?: string
        } = {},
    ): Observable<MessageDataExit> {
        return this.workersFactory$.pipe(
            filter((pool) => pool != undefined),
            take(1),
            mergeMap((workersPool) => {
                const title = 'Execute python'
                const context = new Context(title)
                return workersPool.schedule({
                    title,
                    entryPoint: entryPointExe,
                    targetWorkerId: options.targetWorkerId,
                    args: {
                        content: code,
                        fileSystem: fileSystem,
                        exportedPyodideInstanceName:
                            PyodideSetup.ExportedPyodideInstanceName,
                        pythonGlobals: pythonGlobals,
                    },
                    context,
                })
            }),
            tap((message) => {
                dispatchWorkerMessage(message, rawLog$, options.workerListener)
            }),
            filter((d) => d.type == 'Exit'),
            map((result) => result.data as unknown as MessageDataExit),
            take(1),
        )
    }

    getPythonProxy(
        state: EnvironmentState<WorkersPoolImplementation, IdeState>,
        rawLog$: Subject<RawLog>,
    ) {
        return new WorkerPoolPythonProxy({ state, rawLog$ })
    }

    terminate() {
        this.workersFactory$
            .pipe(filter((factory) => factory != undefined))
            .subscribe((factory) => {
                factory.terminate()
            })
    }
}

interface PythonProxyScheduleInput {
    title: string
    entryPoint: {
        file: string
        function: string
    }
    argument: unknown
}

export class WorkerPoolPythonProxy {
    /**
     * @group Immutable Constants
     */
    public readonly state: EnvironmentState<WorkersPoolImplementation, IdeState>

    /**
     * @group Observables
     */
    public readonly rawLog$: Subject<RawLog>

    constructor(params: {
        state: EnvironmentState<WorkersPoolImplementation, IdeState>
        rawLog$: Subject<RawLog>
    }) {
        Object.assign(this, params)
    }

    async schedule(
        input: PythonProxyScheduleInput,
        workerChannel: WorkerListener,
    ) {
        input = objectPyToJs(
            self[PyodideSetup.ExportedPyodideInstanceName],
            input,
        )
        const filesystem = this.state.ideState.fsMap$.value
        const src = patchPythonSrc(`
from ${input.entryPoint.file} import ${input.entryPoint.function}       
result = ${input.entryPoint.function}(test_glob_var)
result
        `)
        return new Promise((resolve) => {
            this.state.executingImplementation
                .execPythonCode(
                    src,
                    filesystem,
                    this.rawLog$,
                    { test_glob_var: input.argument },
                    {
                        workerListener: workerChannel,
                    },
                )
                .subscribe((messageResult: MessageDataExit) => {
                    resolve(messageResult.result)
                })
        })
    }

    reserve(workersCount) {
        return new Promise<void>((resolve) => {
            this.state.executingImplementation.workersFactory$
                .pipe(
                    filter((factory) => factory != undefined),
                    mergeMap((factory) => {
                        return factory.reserve({ workersCount })
                    }),
                )
                .subscribe(() => {
                    resolve()
                })
        })
    }
}
