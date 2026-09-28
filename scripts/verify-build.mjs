import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBuildIdentityFile, verifyBuildArtifacts } from '../src/main/build-identity.ts'

const root = resolve(process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url))))
const identity = readBuildIdentityFile(join(root, 'out/main/build-identity.json'))
if (identity === null) throw new Error('Build manifest is missing. Run the full build first.')
verifyBuildArtifacts(root, identity)
console.log(`Verified build ${identity.artifactDigest}`)
