import { RawLog, View } from '../models'
import { ProjectState } from '../project-state'
import { PyodideSetup } from '../../pyodide-setup'

export function patchPythonSrc(originalSrc: string) {
    return `
import sys
from yw_pyodide import log_info, log_error

class LoggerInfo(object):
    def __init__(self):
        self.terminal = sys.stdout

    def write(self, message):
        log_info(message)
        
class LoggerError(object):
    def __init__(self):
        self.terminal = sys.stderr

    def write(self, message):
        print("An error!!", message)
        log_error(message)
        
sys.stdout = LoggerInfo()  
sys.stderr = LoggerError()       

${originalSrc}
`
}

export async function registerYwPyodideModule(
    pyodide,
    outputs: {
        onLog: (log: RawLog) => void
        onView: (view: View) => void
        onData: (d: unknown) => void
    },
) {
    pyodide.registerJsModule('yw_pyodide', {
        log_info: (message: string) => {
            message.trim() != '' &&
                outputs.onLog({
                    level: 'info',
                    message: message,
                })
        },
        log_error: (message: string) => {
            message.trim() != '' &&
                outputs.onLog({
                    level: 'error',
                    message: message,
                })
        },
        new: (T, ...p) => new T(...p),
        call: (obj: unknown, method: string, ...args) => obj[method](...args),
        create_view: (name: string, htmlElement) => {
            outputs.onView({
                name,
                htmlElement,
            })
        },
        cdn_client: window['@youwol/cdn-client'],
    })
}

export async function registerPyPlayModule(pyodide, appState: ProjectState) {
    pyodide.registerJsModule('python_playground', {
        main_thread: {
            application: appState.getPythonProxy(),
            worker: {
                Listener: (cb) => {
                    return new WorkerListener(cb)
                },
            },
        },
    })
}

export async function registerJsModules(
    pyodide,
    fileSystem: Map<string, string>,
) {
    for (const key of Array.from(fileSystem.keys())) {
        const value = fileSystem.get(key)
        if (key.endsWith('.js')) {
            const jsModule = await new Function(value)()(window)
            const name = key.substring(2).split('.js')[0]
            pyodide.registerJsModule(name, jsModule)
        }
    }
}

export async function cleanJsModules(pyodide, fileSystem: Map<string, string>) {
    for (const key of Array.from(fileSystem.keys())) {
        if (key.endsWith('.js')) {
            const moduleName = key.substring(2).split('.js')[0]
            pyodide.runPython(
                `import sys\nif '${moduleName}' in sys.modules:\n    del sys.modules['${moduleName}']`,
            )
        }
    }
}

export async function syncFileSystem(pyodide, fileSystem: Map<string, string>) {
    fileSystem.forEach((value, path) => {
        path.endsWith('.py') &&
            pyodide.FS.writeFile(path, value, {
                encoding: 'utf8',
            })
    })
}

export async function cleanFileSystem(
    pyodide,
    fileSystem: Map<string, string>,
) {
    fileSystem.forEach((value, path) => {
        if (path.endsWith('.py')) {
            const moduleName = (
                self['getModuleNameFromFile'] || getModuleNameFromFile
            )(path)
            pyodide.FS.unlink(path)
            pyodide.runPython(
                `import sys\nif '${moduleName}' in sys.modules:\n    del sys.modules['${moduleName}']`,
            )
        }
    })
}

export function getModuleNameFromFile(path: string) {
    return path.replace('.js', '').replace('.py', '').replace('./', '')
}

export class WorkerListener {
    callback: (d) => void

    constructor(onData) {
        const pyodide = self[PyodideSetup.ExportedPyodideInstanceName]
        const namespace = pyodide.toPy({ onData })
        this.callback = pyodide.runPython(
            `
from pyodide.ffi import create_proxy
create_proxy(onData)
        `,
            {
                globals: namespace,
            },
        )
    }

    emit(d) {
        this.callback(d)
    }
}
