import { BehaviorSubject, ReplaySubject } from 'rxjs'
import { IdeState, Project, RawLog, WorkersPool } from './models'
import { take } from 'rxjs/operators'
import { MainThreadImplementation } from './main-thread'
import { WorkersPoolImplementation } from './workers-pool'

import { EnvironmentState } from './environment.state'

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
    }

    run() {
        this.pyWorkersState$.pipe(take(1)).subscribe(() => {
            this.mainThreadState.run()
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
}
