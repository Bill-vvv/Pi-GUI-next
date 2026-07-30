export declare const OPENAI_FAST_MODE_COMMAND_NAME: 'pi-gui-openai-fast-mode-control'
export declare const OPENAI_FAST_MODE_ENTRY_TYPE: 'pi-gui-openai-fast-mode/state'

export declare function buildOpenAiFastModeCommandArgs(enabled: boolean): 'on' | 'off'
export declare function buildOpenAiFastModeEntryData(enabled: boolean): { enabled: boolean }
export declare function parseOpenAiFastModeEntryData(data: unknown): boolean | null
export declare function parseOpenAiFastModeCommandArgs(args: unknown): boolean | null
export declare function isInternalOpenAiFastModeCommandName(name: unknown): boolean
