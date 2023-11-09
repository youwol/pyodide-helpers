/**
 * ## Context
 *
 * Context objects are used to track execution flows in the module's implementation
 * (or at other places). It enables:
 * -    meaningful reporting of what is going on (wrong or not)
 * during module's execution (see also [[Journal]])
 * -    understanding the bottleneck in terms of performances
 * -    [[Log]] broadcasting to multiple destinations
 *
 * Context can be used in synchronous or asynchronous scenarios, the following example
 * illustrates both usages (code is simplified to only keep the relevant points):
 *
 * ```typescript
 *  class Module extends ModuleFlux{
 *
 *      output$ : Pipe<unknown>
 *
 *      constructor(params) {
 *          super(params)
 *              addInput({
 *                  onTriggered: ({data, context}) =>
 *                      this.process(data, context)
 *              })
 *              this.addOutput({id:'output'})
 *      }
 *
 *      process(data, context: Context) {
 *
 *          let data1 = context.withChild( 'syncStep', () => syncStep(data, context) )
 *          ctx.info("Synchronous step was successful", data1)
 *
 *          asyncStep(data1, context).subscribe(
 *              (result) => {
 *                  this.output$.next(result);
 *                  // it is always the responsibility of the developer to close
 *                  // the context provided to 'onTriggered'
 *                  context.end()
 *               };
 *              (error) => {
 *                  ctx.error( error )
 *                  context.end()
 *              }
 *      }
 *
 *      syncStep( data, context: Context){
 *
 *          context.info("Starting sync step", data)
 *          let value // = ... the result of some computations
 *          return value
 *      }
 *
 *      async asyncStep( data: unknown, context: Context): Observable<any> {
 *
 *          let ctx = context.startChild('async step')
 *          ctx.info("Starting async step, expect 10 values to come", data)
 *
 *          return from(
 *              // a source of async data, e.g. requests, multi-threaded computations, etc
 *              ).pipe(
 *              tap( (value) => ctx.info("got a value", value))
 *              take(10),
 *              reduce( (acc,e) => acc.concat(e), [])
 *              tap( (acc) => {
 *                  ctx.info("got all 10 values", acc)
 *                  ctx.end()
 *              })
 *          )
 *      }
 * }
 * ```
 *
 * > #### Synchronous cases
 * > The Context class provide the method [[withChild]], the developer is not
 * > in charge to *start* or *end* the child context as it is automatically managed.
 * > If an error is thrown and not catched during the callback execution, the child context end (along with its parents),
 * > the error is reported in the child context, and finally the error is re-thrown.
 *
 * > #### Asynchronous cases
 * > The Context class provides the method [[startChild]] & [[end]].
 * > It is the developer responsibility to call these methods at the right time, and also
 * > to deal with eventual exceptions.
 *
 * The natural representation of a context (as presented in [flux-builder](https://github.com/youwol/flux-builder)),
 * is a tree view representing the tree structure of the function calls chain.
 * The children of a context can be of two types:
 * -    [[Log]] : an element of log, either [[InfoLog]], [[WarningLog]] or [[ErrorLog]]
 * -    [[Context]] : a child context
 *
 * ### Logs broadcasting
 *
 * Context objects can includes broadcasting [[Context.channels$]] to multiple
 * destinations and with different filters/maps through [[LogChannel]].
 *
 * Context from modules' execution use 2 channels:
 * -    all logs are broadcasted to [[ModuleFlux.logs$]]
 * -    error logs are broadcasted to [[Environment.errors$]]
 *
 *
 * ### A note about user-context
 *
 * The Context object also conveys the **user-context** (it is discussed along with [[Adaptor]]).
 * The library can not automatically forward the user-context when output are sent:
 * it is not always as meaningful as expected, and the asynchronous (possibly multi-threaded)
 *  nature of module's processes makes it close to impossible (at least we did not find a safe way of doing so 🤫).
 *
 * This explains why, when emitting a value through an output pipe, you should explicitly pass
 *  back the context that has been provided to you at the first place (to the *onTriggered* callback).
 *
 * @format
 * @module context
 */

import { Subject } from 'rxjs'
import { v4 as uuidv4 } from 'uuid'

/**
 * ## Log
 *
 * The class Log is the base class for the concrete types [[ErrorLog]], [[WarningLog]] and [[InfoLog]].
 * It is one of the two [[Context]]'s structuring entities (the other one being a child [[Context]]).
 *
 * Log objects are central in Flux for the reporting mechanism (the same way [[Context]] are).
 * In particular, one interesting feature related to log & reporting is the possibility for the developer
 * of modules to register custom view factories associated to some data types.
 * Doing so allows to include in the Flux journals adapted and interactive views to help
 * the builder of Flux applications to better understand the data transformation flow during a processing.
 * Examples include interactive 3D visualization, on the fly reporting of convergence
 * results in 2D graphs, etc.
 * The registration of the factories is handled by the class [[Journal]].
 *
 */
export class Log {
    /**
     * timestamp corresponding to the instance construction
     */
    public readonly timestamp = performance.now()

    /**
     * uuid
     */
    public readonly id = uuidv4()

    /**
     *
     * @param context parent context
     * @param text description of the log
     * @param data associated data
     */
    constructor(
        public readonly context: Context,
        public readonly text: string,
        public readonly data?: unknown,
    ) {}

    /**
     *
     * @param from reference timestamp
     * @returns [[timestamp]] - from
     */
    elapsed(from) {
        return this.timestamp - from
    }
}

/**
 * ## ErrorLog
 *
 * Class specialization of  [[Log]] for errors.
 */
export class ErrorLog<TError extends Error, TData = unknown> extends Log {
    constructor(
        context: Context,
        public readonly error: TError,
        data: TData,
    ) {
        super(context, error.message, data)
    }
}

/**
 * ## WarningLog
 *
 * Class specialization of [[Log]] for warnings.
 */
export class WarningLog extends Log {
    constructor(
        context: Context,
        public readonly text: string,
        data: unknown,
    ) {
        super(context, text, data)
    }
}

/**
 * ## InfoLog
 *
 * Class specialization of [[Log]] for info.
 */
export class InfoLog extends Log {
    constructor(
        context: Context,
        public readonly text: string,
        data: unknown,
    ) {
        super(context, text, data)
    }
}

/**
 * ## LogChannel
 *
 * The class LogChannel allows to broadcast Log to multiple
 * destinations using a user defined filtering (selection of logs)
 * and mapping (transformation of selected logs before emission).
 *
 * This class is a companion of [[Context]].
 */
export class LogChannel<T = unknown> {
    /**
     * User defined function that return whether or not a [[Log]] should be broadcasted
     */
    filter: (data: Log) => boolean

    /**
     * User defined function that, if provided, transform the selected logs into
     * a target type of message. If not provided at construction the function
     * identity is used.
     */
    map: (data: Log) => T

    /**
     * A list of consumers of the messages as RxJs subjects
     */
    pipes: Array<Subject<T>>

    /**
     *
     * @param filter  see [[filter]]
     * @param map  see [[map]]
     * @param pipes  see [[pipes]]
     */
    constructor({
        filter,
        map,
        pipes,
    }: {
        filter: (data: Log) => boolean
        map?: (data: Log) => T
        pipes: Array<Subject<T>>
    }) {
        this.filter = filter
        this.map = map == undefined ? (d) => d as unknown as T : map
        this.pipes = pipes
    }

    /**
     * If *this.filter(log)* -> dispatches *this.map(log)* to all subjects
     * @param log candidate log
     */
    dispatch(log: Log) {
        if (this.filter(log)) {
            this.pipes.forEach((pipe) => {
                pipe.next(this.map(log))
            })
        }
    }
}

export enum ContextStatus {
    SUCCESS = 'success',
    RUNNING = 'running',
    FAILED = 'failed',
}
/**
 * ## Context
 *
 * Context objects are used to essentially track the execution flow of some processing
 * functions, essentially to:
 * -    enable meaningful reporting of what is going on (wrong or not)
 * during module's execution (see also [[Journal]])
 * -    understand the bottleneck in terms of performances
 * -    enable [[Log]] broadcasting to multiple destinations
 *
 * Context can be used in synchronous or asynchronous scenarios, the following example
 * illustrates both usages (code is simplified to only keep the relevant points):
 *
 * ```typescript
 *  class Module extends ModuleFlux{
 *
 *      output$ : Pipe<unknown>
 *
 *      constructor(params) {
 *          super(params)
 *              addInput({
 *                  onTriggered: ({data, context}) =>
 *                      this.process(data, context)
 *              })
 *              this.addOutput({id:'output'})
 *      }
 *
 *      process(data, context: Context) {
 *
 *          let data1 = context.withChild( 'syncStep', () => syncStep(data, context) )
 *          ctx.info("Synchronous step was successful", data1)
 *
 *          asyncStep(data1, context).subscribe(
 *              (result) => {
 *                  this.output$.next(result);
 *                  // it is always the responsibility of the developer to close
 *                  // the context provided to 'onTriggered'
 *                  context.end()
 *               };
 *              (error) => {
 *                  ctx.error( error )
 *                  context.end()
 *              }elapsed time
 *      }
 *
 *      syncStep( data, context: Context){
 *
 *          context.info("Starting sync step", data)
 *          let value // = ... the result of some computations
 *          return value
 *      }
 *
 *      async asyncStep( data: unknown, context: Context): Observable<any> {
 *
 *          let ctx = context.startChild('async step')
 *          ctx.info("Starting async step, expect 10 values to come", data)
 *
 *          return from(
 *              // a source of async data, e.g. requests, multi-threaded computations, etc
 *              ).pipe(
 *              tap( (value) => ctx.info("got a value", value))
 *              take(10),
 *              reduce( (acc,e) => acc.concat(e), [])
 *              tap( (acc) => {
 *                  ctx.info("got all 10 values", acc)
 *                  ctx.end()
 *              })
 *          )
 *      }
 * }
 * ```
 * The difference between sync. and async. scenario is whether or not it is needed to call
 * *context.close*:
 * -    for synchronous cases, the Context class provide the method [[withChild]], the developer is not
 * in charge to *start* or *end* the child context as it is automatically managed.
 * If an error is thrown and not catched during the callback execution, the child context end (along with its parents),
 * the error is reported in the child context, and finally the error is re-thrown.
 * -    for asynchronous cases, the Context class provides the method [[startChild]],
 * it is then the developer responsibility to call the method [[end]] at the right time, and
 * to deal with eventual exceptions.
 *
 * The natural representation of a context, as presented in Flux applications, is a tree view
 * representing the tree structure of the chain of function calls. The children of a context can be of two types:
 * -    [[Log]] : an element of log, either [[InfoLog]], [[WarningLog]] or [[ErrorLog]]
 * -    [[Context]] : a child context
 *
 * ### Logs broadcasting
 *
 * Context objects can feature broadcasting [[channels$]] to multiple
 * destinations and with different filters through [[LogChannel]]. For instance, [[ModuleFlux]] use
 * two channels:
 * -     all logs are broadcasted to [[ModuleFlux.logs$]]
 * -     error logs are broadcasted to [[Environment.errors$]]
 *
 *
 * ### A note about user-context
 *
 * The Context object also conveys the **user-context**.
 * The user-context is a *key->value* dictionary filled by the builder
 * of a Flux application (using [[Adaptor | adaptors]]) that needs to be forwarded
 * from modules to modules.
 * The library can not automatically forward the user-context when output are sent:
 * it is not always as meaningful as expected (e.g. what is the output context of a
 *  combining type of module?), and the asynchronous (possibly multi-threaded)
 *  nature of module's processes makes it impossible (meaning we did not find a safe way of doing so 🤫).
 *
 * This explains why, when emitting a value through an output pipe, you should explicitly pass
 *  back the context that has been provided for you at the first place (to the *onTriggered* callback).
 */
export class Context {
    /**
     * Context's children
     */
    children = new Array<Context | Log>()

    /**
     * [[uuidv4]]
     */
    id = uuidv4()

    /**
     * timestamp corresponding to the instance creation
     */
    public readonly startTimestamp = performance.now()

    private endTimestamp: number

    /**
     *
     * @param title title of the context
     * @param userContext user-context
     * @param channels$ broadcasting channels
     * @param parent parent context if not root
     */
    constructor(
        public readonly title: string,
        public userContext: { [key: string]: unknown } = {},
        public readonly channels$: Array<LogChannel> = [],
        public readonly parent = undefined,
    ) {}

    /**
     * Start a new child context, supposed to be used in asynchronous scenarios.
     *
     * The attribute *userContext* of the child context  is a clone of the parent's user-context, eventually
     * merged with provided *withUserContext*. *withUserContext* is needed for very specific cases, usually
     * there is no need to provide one.
     *
     * @param title title of the child context
     * @param withUserContext user context entries to add
     * @returns the child context
     */
    startChild(
        title: string,
        withUserContext: { [key: string]: unknown } = {},
    ): Context {
        const childCtx = new Context(
            title,
            { ...this.userContext, ...withUserContext },
            this.channels$,
            this,
        )
        this.children.push(childCtx)
        return childCtx
    }

    /**
     * Wrap a new child context around a callback, supposed to be used in synchronous scenarios.
     * In this case the developer does not need to handle *start* or *end* of the child context.
     *
     * The attribute *userContext* of the child context is a clone of the parent's user-context, eventually
     * merged with provided *withUserContext*. *withUserContext* is needed for very specific cases, usually
     * there is no need to provide one.
     *
     * If an error is thrown and not catched during the callback execution, the child context end (along with its parents),
     * the error is reported in the child context, and finally the error is re-thrown.
     *
     * @param title title of the child context
     * @param callback the callback, the child context is provided as argument of the callback
     * @param withUserInfo user context entries to add
     * @returns the child context
     */
    withChild<T>(
        title: string,
        callback: (context: Context) => T,
        withUserInfo: { [key: string]: unknown } = {},
    ): T {
        const childContext = new Context(
            title,
            { ...this.userContext, ...withUserInfo },
            this.channels$,
            this,
        )
        this.children.push(childContext)
        try {
            const result = callback(childContext)
            childContext.end()
            return result
        } catch (error) {
            childContext.error(error, error.data || error.status)
            childContext.end()
            throw error
        }
    }

    /**
     *
     * @returns the root context of the tree
     */
    root(): Context {
        return this.parent ? this.parent.root() : this
    }

    /**
     * Log an [[ErrorLog]].
     *
     * @param error the error
     * @param data some data to log with the error
     */
    error(error: Error, data?: unknown) {
        this.addLog(new ErrorLog(this, error, data))
    }

    /**
     * Log a [[WarningLog]].
     *
     * @param text description of the warning
     * @param data some data to log with the warning
     */
    warning(text: string, data?: unknown) {
        this.addLog(new WarningLog(this, text, data))
    }

    /**
     * Log an [[InfoLog]].
     *
     * @param text info
     * @param data some data to log with the info
     */
    info(text: string, data?: unknown) {
        this.addLog(new InfoLog(this, text, data))
    }

    /**
     * End the context manually when [[startChild]] has been
     * used to create it (in contrast to [[withChild]]).
     *
     * Used for asynchronous scenarios.
     */
    end() {
        this.endTimestamp = performance.now()
    }

    /**
     * Call [[end]] on this context, and call [[terminate]] on the parent
     */
    terminate() {
        this.end()
        this.parent && this.parent.terminate()
    }

    /**
     * @param from a reference timestamp, use this.[[startTimestamp]] if not provided
     * @returns Either the 'true' elapsed time of this context if it has ended or the maximum
     * [[elapsed]](this.startTimestamp) of the children (recursive lookup)
     */
    elapsed(from?: number): number | undefined {
        from = from || this.startTimestamp

        const getElapsedRec = (from: number, current: Context) => {
            if (current.endTimestamp) {
                return current.endTimestamp - from
            }
            const maxi = current.children
                .map((child: Context | Log) => child.elapsed(from))
                .filter((elapsed) => elapsed != undefined)
                .reduce((acc, e) => (e > acc ? e : acc), -1)
            return maxi == -1 ? undefined : maxi
        }
        return getElapsedRec(from, this)
    }

    /**
     *
     * @returns whether the context is [[ContextStatus.RUNNING]], [[ContextStatus.SUCCESS]]
     * or [[ContextStatus.FAILED]]
     */
    status(): ContextStatus {
        const isErrorRec = (ctx: Context) => {
            return (
                ctx.children.find((child) => child instanceof ErrorLog) !=
                    undefined ||
                ctx.children
                    .filter((child) => child instanceof Context)
                    .find((child: Context) => isErrorRec(child)) != undefined
            )
        }

        if (isErrorRec(this)) {
            return ContextStatus.FAILED
        }

        if (this.endTimestamp != undefined) {
            return ContextStatus.SUCCESS
        }

        return ContextStatus.RUNNING
    }

    private addLog(log: Log) {
        this.children.push(log)
        this.channels$.forEach((channel) => channel.dispatch(log))
    }
}

/**
 * ## Journal
 *
 * The Journal class encapsulates the required information to render a [[Context]]
 * (and its children) in an HTML document.
 *
 * >
 * >  <figure class="image" style="text-align: center; font-style: italic">
 * >    <img src="https://raw.githubusercontent.com/youwol/flux-builder/master/images/screenshots/journal.png" alt=""
 * >    >
 * >    <figcaption> flux-builder's journal presentation</figcaption>
 * > </figure>
 *
 *
 * The class gathers:
 * -    an entry point context, basically the root function call
 * -    registered custom views associated to some particular data (usually w/ their type)
 *
 * ### Registering a custom view
 *
 * Below is an example of a module willing to provide feedbacks on a convergence process
 * as it goes. Looking at the journal while the module is running would present a 2D graph with live updates.
 *
 * The library [flux-view](https://github.com/youwol/flux-view) is used in the example, the same
 * can most likely be done with your favorite library (an HTMLElement is required at the end).
 *
 *
 * ```typescript
 * import * as Plotly from 'plotly.js-gl2d-dist-min'
 * import Journal from './flux-core'
 * import {VirtualDOM, render} from './flux-view'
 * import {compute} from 'somewhere'
 *
 * class DataView{
 *      source$ = new Subject<Array<[number, number]>()
 *      constructor(){}
 * }
 *
 * function journalView( data$ : Observable<Array<[number,number]>) : HTMLElement{
 *      let id = uuidv4()
 *      let vDOM : VirtualDOM = {
 *          id,
 *          class: "w-100 h-100",
 *          connectedCallback: (div) =>
 *              elem.ownSubscriptions(
 *                  data$.subscribe( data => Plotly.newPlot(div, data) );
 *              )
 *          }
 *      }
 *      return render(vDOM)
 * }
 *
 * Journal.registerView<ConvergenceDataView>({
 *      name: 'convergence Module X',
 *      isCompatible: (d:unknown) => d instanceof(ConvergenceDataView),
 *      view: (d:ConvergenceDataView) => journalView(d.source$)
 * })
 *
 *  class Module extends ModuleFlux{
 *      // ...
 *      process(data, context: Context) {
 *
 *          let dataView = new DataView()
 *
 *          context.info( "Live convergence result", dataView )
 *          // compute is supposed to run in another worker, and to provide
 *          // updates on convergence into dataView.source$ stream
 *          compute(data, dataView.source$, context).subscribe(
 *              (result) => {
 *                  this.output$.next(result);
 *                  context.end()
 *               };
 *      }
 *  }
 * ```
 *
 * > #### Declaring data
 * > A data structure (here DataView) need to be defined to encapsulate
 * > all the data needed by the view
 *
 * > #### Implementing a view function
 * > A function (here journalView) is required to map the data to the view
 * > element
 *
 * > #### Registering the view
 * > A call to [[registerView]] with the callback functions
 *
 * > #### Usage in the module
 * > A simple  ```context.info( "Live convergence result", dataView )``` is inserting
 * > the reference on the view factory at the right location in the journal.
 * >
 */
export class Journal {
    /**
     * The entry point: the journal can render this context and all of its children
     */
    entryPoint: Context

    /**
     * title of the journal
     */
    title: string

    /**
     * abstract of the journal
     */
    abstract: string | undefined

    /**
     * Registered widgets that are used to render the *data* property of
     * a [[Log]] if possible (if the function [[JournalWidget.isCompatible]] apply
     * to this *data* return true).
     */
    private static views: Array<{
        name: string
        description?: string
        isCompatible: (data: unknown) => boolean
        view: (data: unknown) => HTMLElement
    }> = []

    /**
     * Register a new factory to display some data using a specific view.
     *
     * It allows for *flux-pack* developer (or host applications) to register
     * custom views to help the builder of flux applications understanding
     * module's processes.
     *
     * An example is provided in the class documentation.
     *
     *
     * @param name name of the factory
     * @param description description
     * @param isCompatible a function that takes data as argument and return true if it can be processed
     * by the factory to create a view
     * @param view a function that takes a data as argument (for which isCompatibe(data) is true) and return an HTMLElement
     */
    public static registerView<TData>({
        name,
        description,
        isCompatible,
        view,
    }: {
        name: string
        description?: string
        isCompatible: (data: unknown) => boolean
        view: (data: TData) => HTMLElement
    }) {
        description = description ? description : ''
        Journal.views.push({ name, description, isCompatible, view })
    }

    /** Returns the (instantiated) views compatible with given source data
     *
     * @param data source data
     * @return instantiated view with name and description of the factory used
     */
    public static getViews(
        data: unknown,
    ): Array<{ name: string; description: string; view: HTMLElement }> {
        return Journal.views
            .filter((factory) => factory.isCompatible(data))
            .map((factory) => ({
                name: factory.name,
                description: factory.description,
                view: factory.view(data),
            }))
    }
    /**
     *
     * @param title see [[title]]
     * @param entryPoint see [[entryPoint]]
     * @param abstract see [[entryPoint]]
     */
    constructor({
        title,
        entryPoint,
        abstract,
    }: {
        title: string
        entryPoint: Context
        abstract?: string
    }) {
        this.entryPoint = entryPoint
        this.title = title
        this.abstract = abstract
    }
}
