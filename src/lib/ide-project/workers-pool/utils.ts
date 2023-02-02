import {
    MessageDataExit,
    MessageEventData,
    WorkersFactory,
} from './workers-factory'
import { RawLog } from '../models'
import { Subject } from 'rxjs'
import {
    cleanFileSystem,
    cleanJsModules,
    getModuleNameFromFile,
    registerJsModules,
    registerYwPyodideModule,
    syncFileSystem,
    WorkerListener,
} from '../in-worker-executable'
import {
    CdnEvent,
    getUrlBase,
    InstallLoadingGraphInputs,
    setup as cdnSetup,
} from '@youwol/cdn-client'
import { setup } from '../../../auto-generated'
import { entryRegisterPyPlayAddOns } from './workers-pool.implementation'
import { PyodideSetup } from '../../pyodide-setup'

export interface CdnEventWorker {
    text: string
    workerId: string
    id: string
}

export interface MessageCdnEventData {
    type: string
    workerId: string
    event: {
        id: string
        text: string
    }
}

export interface PythonStdOut {
    message: string
    workerId: string
}

export interface ErrorExit {
    message: string
    workerId: string
}

export interface MessagePythonStdOutData {
    type: string
    workerId: string
    log: {
        message: string
    }
}

export interface MessageUserData {
    type: string
    workerId: string
    data: unknown
}

export function isCdnEventMessage(
    message: MessageEventData,
): undefined | CdnEventWorker {
    if (message.type != 'Data') {
        return undefined
    }
    const data = message.data as unknown as MessageCdnEventData
    if (data.type == 'CdnEvent') {
        return { ...data.event, workerId: data.workerId }
    }
    return undefined
}

export function isPythonStdOutMessage(
    message: MessageEventData,
): undefined | PythonStdOut {
    if (message.type != 'Data') {
        return undefined
    }
    const data = message.data as unknown as MessagePythonStdOutData
    if (data.type == 'PythonStdOut') {
        return { workerId: data.workerId, message: data.log.message }
    }
    return undefined
}

export function isErrorExitMessage(
    message: MessageEventData,
): undefined | ErrorExit {
    if (message.type != 'Exit') {
        return undefined
    }
    const data = message.data as unknown as MessageDataExit
    if (!data.error) {
        return undefined
    }
    const error = data.result as Error
    return { workerId: data.workerId, message: error.message }
}

export function isUserDataMessage(
    message: MessageEventData,
): undefined | unknown {
    if (message.type != 'Data') {
        return undefined
    }
    const data = message.data as unknown as MessageUserData
    if (data.type == 'WorkerData') {
        return data.data
    }
    return undefined
}

export function dispatchWorkerMessage(
    message: MessageEventData,
    rawLog$: Subject<RawLog>,
    workerListener: WorkerListener,
) {
    const stdOut = isPythonStdOutMessage(message)
    if (stdOut) {
        rawLog$.next({
            level: 'info',
            message: `${stdOut.workerId}:${stdOut.message}`,
        })
        return
    }
    const errorExit = isErrorExitMessage(message)
    if (errorExit) {
        rawLog$.next({
            level: 'error',
            message: `${errorExit.workerId}:${errorExit.message}`,
        })
        return
    }
    const userData = isUserDataMessage(message)
    if (userData && workerListener) {
        workerListener.emit(userData)
        return
    }
}

export function objectPyToJs(pyodide, object) {
    const namespace = pyodide.toPy({ object })
    return pyodide.runPython(
        `
from pyodide.ffi import to_js
from js import Object
to_js(object, dict_converter= Object.fromEntries)
        `,
        {
            globals: namespace,
        },
    )
}

export function initializeWorkersPool(
    lockFile: InstallLoadingGraphInputs,
    minWorkersCount: number,
    cdnEvent$: Subject<CdnEvent>,
) {
    const cdnPackage = '@youwol/cdn-client'
    const workersFactory = new WorkersFactory({
        cdnEvent$,
        hostName:
            window.location.origin != 'null'
                ? window.location.origin
                : window.location.ancestorOrigins[0],
        cdnUrl: `${getUrlBase(
            cdnPackage,
            cdnSetup.version,
        )}/dist/${cdnPackage}.js`,
        functions: {
            objectPyToJs: objectPyToJs,
            syncFileSystem: syncFileSystem,
            cleanFileSystem: cleanFileSystem,
            registerJsModules: registerJsModules,
            cleanJsModules: cleanJsModules,
            registerYwPyodideModule: registerYwPyodideModule,
            getModuleNameFromFile: getModuleNameFromFile,
        },
        cdnInstallation: lockFile,
        postInstallTasks: [
            {
                title: 'register py-play add-ons',
                entryPoint: entryRegisterPyPlayAddOns,
                args: {
                    exportedRxjsSymbol:
                        setup.getDependencySymbolExported('rxjs'),
                    exportedPyodideInstanceName:
                        PyodideSetup.ExportedPyodideInstanceName,
                },
            },
        ],
    })
    return {
        workersFactory,
        channels: workersFactory.reserve({
            workersCount: minWorkersCount,
        }),
    }
}
