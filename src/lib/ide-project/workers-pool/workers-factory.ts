/** @format */

import { BehaviorSubject, forkJoin, Observable, of, Subject } from 'rxjs'
import { filter, map, mapTo, take, takeWhile, tap } from 'rxjs/operators'
import { Context } from '../context'
import {
    CdnEvent,
    InstallInputs,
    InstallLoadingGraphInputs,
} from '@youwol/cdn-client'
import { isCdnEventMessage } from './utils'
type WorkerId = string

interface WorkerFunction<T> {
    id: string
    target: T
}

interface WorkerVariable<T> {
    id: string
    value: T
}

interface Task {
    title: string
    entryPoint: (args: unknown) => Promise<unknown>
    args: unknown
}

interface WorkerEnvironment {
    cdnUrl: string
    variables: WorkerVariable<unknown>[]
    functions: WorkerFunction<unknown>[]
    cdnInstallation: InstallInputs | InstallLoadingGraphInputs
    postInstallTasks?: Task[]
}

export interface WorkerContext {
    info: (text: string, data?: unknown) => void
    sendData: (data: Record<string, unknown>) => void
}

interface MessageDataExecute {
    taskId: string
    workerId: string
    entryPoint: string
    args: unknown
}

export interface MessageDataExit {
    taskId: string
    error: boolean
    result: unknown
}

interface MessageDataLog {
    taskId: string
    text: string
    json: unknown // Json
}

export interface MessageDataData {
    taskId: string
    workerId: string
    [k: string]: unknown
}

export interface MessageEventData {
    type:
        | 'Execute'
        | 'installScript'
        | 'Exit'
        | 'Start'
        | 'Log'
        | 'DependencyInstalled'
        | 'Data'
    data: MessageDataExecute | MessageDataData
}

export interface EntryPointArguments<TArgs> {
    args: TArgs
    taskId: string
    context: WorkerContext
    workerScope
}

function entryPointWorker(messageEvent: MessageEvent) {
    const message: MessageEventData = messageEvent.data
    const workerScope = self
    workerScope['window'] = self
    if (message.type == 'Execute') {
        const data: MessageDataExecute =
            message.data as unknown as MessageDataExecute
        const context: WorkerContext = {
            info: (text, json) => {
                workerScope.postMessage({
                    type: 'Log',
                    data: {
                        taskId: data.taskId,
                        workerId: data.workerId,
                        logLevel: 'info',
                        text,
                        json: json,
                    },
                })
            },
            sendData: (consumerData) => {
                workerScope.postMessage({
                    type: 'Data',
                    data: {
                        ...consumerData,
                        ...{ taskId: data.taskId, workerId: data.workerId },
                    },
                })
            },
        }

        const entryPoint = new Function(data.entryPoint)()

        workerScope.postMessage({
            type: 'Start',
            data: {
                taskId: data.taskId,
                workerId: data.workerId,
            },
        })
        try {
            const resultOrPromise = entryPoint({
                args: data.args,
                taskId: data.taskId,
                workerScope: workerScope,
                context,
            })
            if (resultOrPromise instanceof Promise) {
                resultOrPromise
                    .then((result) => {
                        workerScope.postMessage({
                            type: 'Exit',
                            data: {
                                taskId: data.taskId,
                                workerId: data.workerId,
                                error: false,
                                result: result,
                            },
                        })
                    })
                    .catch((error) => {
                        workerScope.postMessage({
                            type: 'Exit',
                            data: {
                                taskId: data.taskId,
                                workerId: data.workerId,
                                error: true,
                                result: error,
                            },
                        })
                    })
                return
            }

            workerScope.postMessage({
                type: 'Exit',
                data: {
                    taskId: data.taskId,
                    workerId: data.workerId,
                    error: false,
                    result: resultOrPromise,
                },
            })
        } catch (e) {
            workerScope.postMessage({
                type: 'Exit',
                data: {
                    taskId: data.taskId,
                    workerId: data.workerId,
                    error: true,
                    result: e,
                },
            })
            return
        }
    }
}

export interface MessageDataInstall {
    cdnUrl: string
    variables: WorkerVariable<unknown>[]
    functions: { id: string; target: string }[]
    cdnInstallation: InstallInputs | InstallLoadingGraphInputs
    postInstallTasks: {
        title: string
        entryPoint: string
        args: unknown
    }[]
}

function entryPointInstall(input: EntryPointArguments<MessageDataInstall>) {
    if (self['@youwol/cdn-client']) {
        // The environment is already installed
        return Promise.resolve()
    }
    function isLoadingGraphInstallInputs(
        body: InstallInputs | InstallLoadingGraphInputs,
    ): body is InstallLoadingGraphInputs {
        return (body as InstallLoadingGraphInputs).loadingGraph !== undefined
    }

    self['importScripts'](input.args.cdnUrl)
    const cdn = self['@youwol/cdn-client']
    cdn.Client.HostName = window.location.origin

    const onEvent = (cdnEvent) => {
        const message = { type: 'CdnEvent', event: cdnEvent }
        input.context.sendData(message)
    }

    input.args.cdnInstallation.customInstallers.map((installer) => {
        installer.installInputs['onEvent'] = onEvent
    })
    const install = isLoadingGraphInstallInputs(input.args.cdnInstallation)
        ? cdn.installLoadingGraph(input.args.cdnInstallation)
        : cdn.install(input.args.cdnInstallation)
    input.context.info('Start install')

    return install
        .then(() => {
            input.args.functions.forEach((f) => {
                self[f.id] = new Function(f.target)()
            })
            input.args.variables.forEach((v) => {
                self[v.id] = v.value
            })
        })
        .then(() => {
            input.context.info('Dependencies installation done')
            for (const task of input.args.postInstallTasks) {
                input.context.info(`Start post-install task '${task.title}'`)
                const entryPoint = new Function(task.entryPoint)()
                entryPoint({
                    args: task.args,
                    context: input.context,
                    taskId: input.taskId,
                    workerScope: input.workerScope,
                })
            }
            input.context.info('Post install tasks done')
            input.context.sendData({
                type: 'installEvent',
                value: 'install done',
            })
        })
}

export class Process {
    public readonly taskId: string
    public readonly title: string
    public readonly context: Context

    constructor(params: { taskId: string; title: string; context: Context }) {
        Object.assign(this, params)
    }

    schedule() {
        console.log('Schedule Process', {
            taskId: this.taskId,
            title: this.title,
        })
    }

    start() {
        console.log('Start Process', { taskId: this.taskId, title: this.title })
    }

    fail(error: unknown) {
        console.log('Failed Process', {
            taskId: this.taskId,
            title: this.title,
            error,
        })
    }

    succeed() {
        console.log('Succeeded Process', {
            taskId: this.taskId,
            title: this.title,
        })
    }

    log(text: string) {
        console.log('Process Log', {
            taskId: this.taskId,
            title: this.title,
            text,
        })
    }
}

export class WorkersFactory {
    public readonly poolSize = navigator.hardwareConcurrency - 2

    public readonly mergedChannel$ = new Subject<MessageEventData>()
    public readonly workers$ = new BehaviorSubject<{
        [p: string]: {
            worker: Worker
            channel$: Observable<MessageEventData>
        }
    }>({})
    public readonly runningTasks$ = new BehaviorSubject<
        { workerId: string; taskId: string }[]
    >([])
    public readonly busyWorkers$ = new BehaviorSubject<string[]>([])
    public readonly workerReleased$ = new Subject<{
        workerId: WorkerId
        taskId: string
    }>()

    public readonly backgroundContext = new Context('background management', {})

    public readonly cdnEvent$: Subject<CdnEvent>

    public readonly environment: WorkerEnvironment

    private tasksQueue: Array<{
        taskId: string
        targetWorkerId?: string
        args: unknown
        channel$: Observable<MessageEventData>
        entryPoint: unknown
    }> = []

    constructor({
        cdnEvent$,
        variables,
        functions,
        cdnInstallation,
        cdnUrl,
        postInstallTasks,
    }: {
        cdnEvent$: Subject<CdnEvent>
        cdnUrl: string
        variables?: { [_k: string]: unknown }
        functions?: { [_k: string]: unknown }
        cdnInstallation?: InstallInputs | InstallLoadingGraphInputs
        postInstallTasks?: Task[]
    }) {
        this.cdnEvent$ = cdnEvent$
        // Need to manage lifecycle of following subscription
        this.workerReleased$.subscribe(({ workerId, taskId }) => {
            this.busyWorkers$.next(
                this.busyWorkers$.value.filter((wId) => wId != workerId),
            )
            this.runningTasks$.next(
                this.runningTasks$.value.filter(
                    (task) => task.taskId != taskId,
                ),
            )

            this.pickTask(workerId, this.backgroundContext)
        })
        this.environment = {
            cdnUrl,
            variables: Object.entries(variables || {}).map(([id, value]) => ({
                id,
                value,
            })),
            functions: Object.entries(functions || {}).map(([id, target]) => ({
                id,
                target,
            })),
            cdnInstallation,
            postInstallTasks,
        }
    }

    reserve({ workersCount }: { workersCount: number }) {
        const context = new Context('Create worker')
        return forkJoin(
            new Array(workersCount)
                .fill(undefined)
                .map(() =>
                    this.createWorker$(context).pipe(
                        map(({ channel$ }) => channel$),
                    ),
                ),
        )
    }

    schedule<TArgs = unknown>({
        title,
        entryPoint,
        args,
        targetWorkerId,
        context,
    }: {
        title: string
        entryPoint: (input: EntryPointArguments<TArgs>) => void
        args: TArgs
        targetWorkerId?: string
        context: Context
    }): Observable<MessageEventData> {
        return context.withChild('schedule thread', (ctx) => {
            const taskId = `t${Math.floor(Math.random() * 1e6)}`
            const p = new Process({
                taskId,
                title,
                context: ctx,
            })
            p.schedule()

            const taskChannel$ = this.getTaskChannel$(p, taskId, context)

            if (targetWorkerId && !this.workers$.value[targetWorkerId]) {
                throw Error('Provided workerId not known')
            }
            if (targetWorkerId && this.workers$.value[targetWorkerId]) {
                this.tasksQueue.push({
                    entryPoint,
                    args,
                    taskId,
                    channel$: taskChannel$,
                    targetWorkerId,
                })

                if (!this.busyWorkers$.value.includes(targetWorkerId)) {
                    this.pickTask(targetWorkerId, ctx)
                }

                return taskChannel$
            }
            const worker$ = this.getIdleWorkerOrCreate$(ctx)
            if (!worker$) {
                this.tasksQueue.push({
                    entryPoint,
                    args,
                    taskId,
                    channel$: taskChannel$,
                })
                return taskChannel$
            }
            worker$
                .pipe(
                    map(({ workerId }) => {
                        ctx.info(`Got a worker ready ${workerId}`)
                        this.tasksQueue.push({
                            entryPoint,
                            args,
                            taskId,
                            channel$: taskChannel$,
                        })
                        this.pickTask(workerId, ctx)
                        return workerId
                    }),
                )
                .subscribe()

            return taskChannel$
        })
    }

    getTaskChannel$(
        exposedProcess: Process,
        taskId: string,
        context: Context,
    ): Observable<MessageEventData> {
        const channel$ = this.mergedChannel$.pipe(
            filter((message) => message.data.taskId == taskId),
            takeWhile((message) => message.type != 'Exit', true),
        )

        channel$
            .pipe(
                filter((message) => message.type == 'Start'),
                take(1),
            )
            .subscribe((message) => {
                context.info(`worker started on task ${taskId}`, message)
                exposedProcess.start()
            })

        channel$
            .pipe(
                filter((message) => message.type == 'Exit'),
                take(1),
            )
            .subscribe((message) => {
                const data = message.data as unknown as MessageDataExit
                if (data.error) {
                    context.info(
                        `worker exited abnormally on task ${taskId}`,
                        message,
                    )
                    exposedProcess.fail(data.result)
                    return
                }
                exposedProcess.succeed()
                context.info(
                    `worker exited normally on task ${taskId}`,
                    message,
                )
            })
        channel$
            .pipe(filter((message) => message.type == 'Log'))
            .subscribe((message) => {
                const data = message.data as unknown as MessageDataLog
                exposedProcess.log(data.text)
                context.info(data.text, data.json)
            })

        return channel$.pipe(
            map((message) => {
                const exitData = message.data as unknown as MessageDataExit
                if (message.type == 'Exit' && exitData.error) {
                    throw Error(String(exitData.result))
                }
                return message
            }),
        )
    }

    getIdleWorkerOrCreate$(context: Context): Observable<{
        workerId: string
        worker: Worker
        channel$: Observable<MessageEventData>
    }> {
        return context.withChild('get worker', (ctx) => {
            const idleWorkerId = Object.keys(this.workers$.value).find(
                (workerId) => !this.busyWorkers$.value.includes(workerId),
            )

            if (idleWorkerId) {
                ctx.info(`return idle worker ${idleWorkerId}`)
                return of({
                    workerId: idleWorkerId,
                    worker: this.workers$.value[idleWorkerId].worker,
                    channel$: this.workers$.value[idleWorkerId].channel$,
                })
            }
            if (Object.keys(this.workers$.value).length < this.poolSize) {
                return this.createWorker$(ctx)
            }
            return undefined
        })
    }

    createWorker$(context: Context): Observable<{
        workerId: string
        worker: Worker
        channel$: Observable<MessageEventData>
    }> {
        return context.withChild('create worker', (ctx) => {
            const workerId = `w${Math.floor(Math.random() * 1e6)}`
            ctx.info(`Create worker ${workerId}`)

            const blob = new Blob(
                ['self.onmessage = ', entryPointWorker.toString()],
                { type: 'text/javascript' },
            )
            const url = URL.createObjectURL(blob)
            const worker = new Worker(url)

            const taskId = `t${Math.floor(Math.random() * 1e6)}`
            const workerChannel$ = new Subject<MessageEventData>()
            const title = 'Install environment'
            const p = new Process({
                taskId,
                title,
                context: ctx,
            })
            p.schedule()
            worker.onmessage = ({ data }) => {
                workerChannel$.next(data)
                this.mergedChannel$.next(data)
            }
            const taskChannel$ = this.getTaskChannel$(p, taskId, context)

            worker.postMessage({
                type: 'Execute',
                data: {
                    taskId,
                    workerId,
                    args: {
                        cdnUrl: this.environment.cdnUrl,
                        variables: this.environment.variables,
                        functions: this.environment.functions.map(
                            ({ id, target }) => ({
                                id,
                                target: `return ${String(target)}`,
                            }),
                        ),
                        cdnInstallation: this.environment.cdnInstallation,
                        postInstallTasks: this.environment.postInstallTasks.map(
                            (task) => {
                                return {
                                    title: task.title,
                                    args: task.args,
                                    entryPoint: `return ${String(
                                        task.entryPoint,
                                    )}`,
                                }
                            },
                        ),
                    },
                    entryPoint: `return ${String(entryPointInstall)}`,
                },
            })

            return workerChannel$.pipe(
                tap((message: MessageEventData) => {
                    const cdnEvent = isCdnEventMessage(message)
                    if (cdnEvent) {
                        this.cdnEvent$.next(cdnEvent)
                    }
                }),
                filter((message) => message.type == 'Exit'),
                take(1),
                tap(() => {
                    this.workers$.next({
                        ...this.workers$.value,
                        [workerId]: { worker, channel$: workerChannel$ },
                    })
                }),
                mapTo({ workerId, worker, channel$: taskChannel$ }),
            )
        })
    }

    /**
     * Start a worker with first task in its queue
     */
    pickTask(workerId: string, context: Context) {
        context.withChild('pickTask', (ctx) => {
            if (
                this.tasksQueue.filter(
                    (task) =>
                        task.targetWorkerId == undefined ||
                        task.targetWorkerId == workerId,
                ).length == 0
            ) {
                return
            }
            this.busyWorkers$.next([...this.busyWorkers$.value, workerId])
            const { taskId, entryPoint, args, channel$ } = this.tasksQueue.find(
                (t) =>
                    t.targetWorkerId ? t.targetWorkerId === workerId : true,
            )

            this.tasksQueue = this.tasksQueue.filter((t) => t.taskId != taskId)

            this.runningTasks$.next([
                ...this.runningTasks$.value,
                { workerId, taskId },
            ])
            const worker = this.workers$.value[workerId].worker

            channel$
                .pipe(
                    filter((message) => {
                        return message.type == 'Exit'
                    }),
                )
                .subscribe((message) => {
                    const exitData = message.data as unknown as MessageDataExit
                    this.workerReleased$.next({
                        taskId: exitData.taskId,
                        workerId,
                    })
                })

            ctx.info('picked task', {
                taskId,
                worker,
                entryPoint: String(entryPoint),
            })
            worker.postMessage({
                type: 'Execute',
                data: {
                    taskId,
                    workerId,
                    args,
                    entryPoint: `return ${String(entryPoint)}`,
                },
            })
        })
    }

    terminate() {
        Object.values(this.workers$.value).forEach(({ worker }) =>
            worker.terminate(),
        )
    }
}
