import { BehaviorSubject, ReplaySubject } from 'rxjs'
import { Project, RawLog } from './models'
import { take } from 'rxjs/operators'
import { MainThreadImplementation } from './main-thread'
import { WorkersPoolImplementation } from './workers-pool'

import { EnvironmentState } from './environment.state'

type MainThreadState = EnvironmentState<MainThreadImplementation>
type WorkersPoolState = EnvironmentState<WorkersPoolImplementation>

/**
 * See https://github.com/pyodide/pyodide/blob/main/docs/usage/faq.md for eventual improvements
 *
 * Regarding interruption of e.g. running worker: https://pyodide.org/en/stable/usage/keyboard-interrupts.html
 * @category State
 */
export class ProjectState {
    /**
     * @group Immutable Constants
     */
    public readonly mainThreadState: MainThreadState

    /**
     * @group Immutable Constants
     */
    public readonly pyWorkersState$: BehaviorSubject<WorkersPoolState[]>

    /**
     * @group Observables
     */
    public readonly rawLog$ = new ReplaySubject<RawLog>()

    constructor(params: {
        project: Project
        createFileSystem: ({ files }) => BehaviorSubject<Map<string, string>>
    }) {
        Object.assign(this, params)

        this.rawLog$.next({
            level: 'info',
            message: 'Welcome to the python playground 🐍',
        })
        this.mainThreadState = new EnvironmentState<MainThreadImplementation>({
            initialModel: params.project,
            rawLog$: this.rawLog$,
            executingImplementation: new MainThreadImplementation({
                appState: this,
            }),
            createFileSystem: params.createFileSystem,
        })
        const initialWorkers = (params.project.workersPools || []).map(
            (workersPool) => {
                return new EnvironmentState<WorkersPoolImplementation>({
                    initialModel: workersPool,
                    rawLog$: this.rawLog$,
                    executingImplementation: new WorkersPoolImplementation({
                        capacity: workersPool.capacity,
                        name: workersPool.name,
                    }),
                    createFileSystem: params.createFileSystem,
                })
            },
        )
        this.pyWorkersState$ = new BehaviorSubject<WorkersPoolState[]>(
            initialWorkers,
        )
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
}
