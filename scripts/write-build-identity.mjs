import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBuildIdentity, BUILD_IDENTITY_FILE_NAME } from '../src/main/build-identity.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const commit = process.env.PI_GUI_SOURCE_COMMIT ?? execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const identity = createBuildIdentity(root, commit, process.env.PI_GUI_BUILD_SOURCE_DIGEST)
writeFileSync(join(root, 'out/main', BUILD_IDENTITY_FILE_NAME), `${JSON.stringify(identity, null, 2)}\n`)
console.log(`Build source ${identity.sourceDigest}; artifacts ${identity.artifactDigest}`)
