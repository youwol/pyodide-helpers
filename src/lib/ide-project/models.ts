import { InstallLoadingGraphInputs } from '@youwol/cdn-client'

export type VirtualDOM = unknown

export interface Source {
    path: string
    content: string
}

export interface Requirements {
    pythonPackages: string[]
    javascriptPackages: { modules: string[]; aliases: { [k: string]: string } }
}

export interface RunConfiguration {
    name: string
    scriptPath: string
    parameters?: string
}

export interface Environment {
    requirements: Requirements
    configurations: RunConfiguration[]
    lockFile?: InstallLoadingGraphInputs
}

export interface WorkersPool {
    id: string
    name: string
    capacity: number
    environment: Environment
    sources: Source[]
}

export interface Project {
    id: string
    name: string
    environment: Environment
    sources: Source[]
    workersPools?: WorkersPool[]
}

export interface WorkerCommon {
    id: string
    name: string
    environment: Environment
    sources: Source[]
}

export interface RawLog {
    level: 'info' | 'warning' | 'error'
    message: string
    data?: unknown
}

export interface View {
    name: string
    htmlElement: VirtualDOM | HTMLElement
}
