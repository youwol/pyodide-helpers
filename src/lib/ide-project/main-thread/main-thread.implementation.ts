import { IdeState, RawLog, View } from '../models'
import {
    BehaviorSubject,
    forkJoin,
    from,
    merge,
    of,
    ReplaySubject,
    Subject,
} from 'rxjs'
import { map, mergeMap, scan } from 'rxjs/operators'

import { ExecutingImplementation } from '../environment.state'
import {
    cleanFileSystem,
    cleanJsModules,
    registerJsModules,
    registerPyPlayModule,
    registerYwPyodideModule,
    syncFileSystem,
} from '../in-worker-executable'
import { ProjectState } from '../project-state'
import {
    CdnEvent,
    InstallDoneEvent,
    installLoadingGraph,
    InstallLoadingGraphInputs,
} from '@youwol/cdn-client'
import { PyodideSetup } from '../../pyodide-setup'

type OutputViewNode = View
/**
 * @category State
 */
export class MainThreadImplementation implements ExecutingImplementation {
    /**
     *
     * @group States
     */
    public readonly appState: ProjectState<IdeState>

    /**
     * @group Observables
     */
    public readonly triggerOutputsCollect$ = new Subject<boolean>()

    /**
     * @group Observables
     */
    public readonly createdOutput$ = new ReplaySubject<OutputViewNode>(1)

    /**
     * @group Observables
     */
    public readonly createdOutputs$ = new BehaviorSubject<OutputViewNode[]>([])

    constructor({ appState }: { appState: ProjectState<IdeState> }) {
        this.appState = appState

        merge(this.triggerOutputsCollect$, this.createdOutput$)
            .pipe(
                scan(
                    (acc, e: true | OutputViewNode) =>
                        e === true ? [] : [...acc, e],
                    [],
                ),
            )
            .subscribe((outputs) => {
                this.createdOutputs$.next(outputs)
            })
    }

    installRequirements(
        lockFile: InstallLoadingGraphInputs,
        rawLog$: Subject<RawLog>,
        cdnEvent$: Subject<CdnEvent>,
    ) {
        const exportedPyodideInstanceName =
            PyodideSetup.ExportedPyodideInstanceName

        return from(
            installLoadingGraph({
                ...lockFile,
                onEvent: (cdnEvent) => {
                    cdnEvent$.next(cdnEvent)
                },
            }),
        ).pipe(
            mergeMap(() => {
                return registerPyPlayAddOns(this.appState, this.createdOutput$)
            }),
            map(() => {
                const pyodide = window[exportedPyodideInstanceName]

                Object.entries(lockFile.aliases).forEach(
                    ([alias, originalName]) => {
                        rawLog$.next({
                            level: 'info',
                            message: `create alias '${alias}' to import '${originalName}' (version ${window[alias].__yw_set_from_version__}) `,
                        })
                        pyodide.registerJsModule(alias, window[alias])
                    },
                )
                const env = new PyodideSetup({
                    pyodide,
                })
                rawLog$.next({
                    level: 'info',
                    message: `Python ${env.pythonVersion.split('\n')[0]}`,
                })
                rawLog$.next({
                    level: 'info',
                    message: `Pyodide ${env.pyodideVersion}`,
                })
                cdnEvent$.next(new InstallDoneEvent())
                return env
            }),
        )
    }

    execPythonCode(code: string, fileSystem: Map<string, string>) {
        this.triggerOutputsCollect$.next(true)
        const pyodide = self[PyodideSetup.ExportedPyodideInstanceName]
        return of(undefined).pipe(
            mergeMap(() => {
                return forkJoin([
                    syncFileSystem(pyodide, fileSystem),
                    registerJsModules(pyodide, fileSystem),
                ])
            }),
            mergeMap(() => {
                return pyodide.runPythonAsync(code, {
                    globals: pyodide.globals.get('dict')(),
                })
            }),
            mergeMap(() => {
                return forkJoin([
                    cleanFileSystem(pyodide, fileSystem),
                    cleanJsModules(pyodide, fileSystem),
                ])
            }),
        )
    }
}

function registerPyPlayAddOns(
    appState: ProjectState<IdeState>,
    createdOutput$: Subject<OutputViewNode>,
) {
    const outputs = {
        onLog: (log) => appState.rawLog$.next(log),
        onView: (view) => {
            createdOutput$.next(view)
        },
        onData: () => {
            /*no op on main thread*/
        },
    }
    const pyodide = self[PyodideSetup.ExportedPyodideInstanceName]
    return from(
        Promise.all([
            registerYwPyodideModule(pyodide, outputs),
            registerPyPlayModule(pyodide, appState),
        ]),
    )
}
