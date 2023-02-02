import { BehaviorSubject, combineLatest, Observable, ReplaySubject } from 'rxjs'
import { IdeState, Project, RawLog, WorkersPool } from './models'
import { map, mergeMap, shareReplay, switchMap, take } from 'rxjs/operators'
import { MainThreadImplementation } from './main-thread'
import { WorkersPoolImplementation } from './workers-pool'

import { EnvironmentState, ExecutingImplementation } from './environment.state'

type MainThreadState<T extends IdeState> = EnvironmentState<
    MainThreadImplementation,
    T
>
type WorkersPoolState<T extends IdeState> = EnvironmentState<
    WorkersPoolImplementation,
    T
>

/**
 * See https://github.com/pyodide/pyodide/blob/main/docs/usage/faq.md for eventual improvements
 *
 * Regarding interruption of e.g. running worker: https://pyodide.org/en/stable/usage/keyboard-interrupts.html
 * @category State
 */
export class ProjectState<TIdeState extends IdeState> {
    /**
     * @group Immutable Constants
     */
    public readonly mainThreadState: MainThreadState<TIdeState>

    /**
     * @group Immutable Constants
     */
    public readonly pyWorkersState$: BehaviorSubject<
        WorkersPoolState<TIdeState>[]
    >

    /**
     * @group Observables
     */
    public readonly rawLog$ = new ReplaySubject<RawLog>()

    /**
     * @group Observables
     */
    public readonly project$: Observable<Project>

    public readonly createIdeState: ({ files }) => TIdeState

    constructor(params: {
        project: Project
        createIdeState: ({ files }) => TIdeState
    }) {
        Object.assign(this, params)

        this.rawLog$.next({
            level: 'info',
            message: 'Welcome to the python playground 🐍',
        })
        this.mainThreadState = new EnvironmentState<
            MainThreadImplementation,
            TIdeState
        >({
            initialModel: params.project,
            rawLog$: this.rawLog$,
            executingImplementation: new MainThreadImplementation({
                appState: this,
            }),
            createIdeState: params.createIdeState,
        })
        const initialWorkers = (params.project.workersPools || []).map(
            (workersPool) => {
                return new EnvironmentState<
                    WorkersPoolImplementation,
                    TIdeState
                >({
                    initialModel: workersPool,
                    rawLog$: this.rawLog$,
                    executingImplementation: new WorkersPoolImplementation({
                        capacity: workersPool.capacity,
                        name: workersPool.name,
                    }),
                    createIdeState: params.createIdeState,
                })
            },
        )
        this.pyWorkersState$ = new BehaviorSubject<
            WorkersPoolState<TIdeState>[]
        >(initialWorkers)

        this.project$ = this.mergeEnvObservable(
            (state) => state.serialized$,
        ).pipe(
            map(([project, ...workers]: [Project, WorkersPool]) => {
                return {
                    ...project,
                    workersPools: workers,
                }
            }),
            shareReplay({ bufferSize: 1, refCount: true }),
        )
    }

    async run() {
        return new Promise((resolve) => {
            this.pyWorkersState$
                .pipe(take(1))
                .pipe(
                    mergeMap(() => {
                        return this.mainThreadState.run()
                    }),
                )
                .subscribe((result) => {
                    resolve(result)
                })
        })
    }

    getPythonProxy() {
        return {
            get_worker_pool: (name: string) => {
                const state = this.pyWorkersState$.value.find(
                    (env) => env.executingImplementation.name == name,
                )
                return state.executingImplementation.getPythonProxy(
                    state,
                    this.rawLog$,
                )
            },
        }
    }

    addWorkersPool(model: WorkersPool) {
        const state = new EnvironmentState<
            WorkersPoolImplementation,
            TIdeState
        >({
            initialModel: model,
            rawLog$: this.rawLog$,
            executingImplementation: new WorkersPoolImplementation({
                name: model.name,
                capacity: model.capacity,
            }),
            createIdeState: this.createIdeState,
        })

        this.pyWorkersState$.next([...this.pyWorkersState$.value, state])
        return state
    }

    deleteWorkersPool(workersPoolState: WorkersPoolState<TIdeState>) {
        workersPoolState.executingImplementation.terminate()
        const pools = this.pyWorkersState$.value.filter(
            (actual_state) => actual_state != workersPoolState,
        )
        this.pyWorkersState$.next(pools)
    }

    public mergeEnvObservable(
        toObs: (
            state: EnvironmentState<ExecutingImplementation, TIdeState>,
        ) => Observable<unknown>,
    ) {
        return this.pyWorkersState$.pipe(
            switchMap((workers) => {
                return combineLatest([
                    toObs(this.mainThreadState),
                    ...workers.map((w) => toObs(w)),
                ])
            }),
        )
    }
}
