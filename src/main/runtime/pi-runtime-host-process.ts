import { servePiRuntimeHost } from './pi-runtime-host-server.ts'
import { SharedPiHost } from './shared-pi-host.ts'

// Entry for the dedicated Pi Runtime process (D-094), built as out/main/pi-runtime-host.js.
servePiRuntimeHost(() => new SharedPiHost())
