/**
 * @category Data Structure
 */
export class PyodideSetup {
    /**
     * @group Immutable Constants
     */
    static ExportedPyodideInstanceName = 'loadedPyodide'

    /**
     * @group Immutable Constants
     */
    public readonly pyodide

    /**
     * @group Immutable Constants
     */
    public readonly pythonVersion: string

    /**
     * @group Immutable Constants
     */
    public readonly pyodideVersion: string

    constructor(params: { pyodide }) {
        Object.assign(this, params)
        this.pythonVersion = this.pyodide.runPython('import sys\nsys.version')
        this.pyodideVersion =
            window[PyodideSetup.ExportedPyodideInstanceName].version
    }
}
