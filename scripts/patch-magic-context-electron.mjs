#!/usr/bin/env node

import { constants } from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const EXPECTED_VERSION = '0.41.0'
const ENVIRONMENT_VARIABLE = 'MAGIC_CONTEXT_PI_BINARY'
const ORIGINAL = `function resolvePiInvocation() {
  const execPath = process.execPath;
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
  if (currentScript && !isBunVirtualScript && existsSync3(currentScript) && isPiCliScript(currentScript)) {
    return { command: execPath, prefixArgs: [currentScript] };
  }
  if (!isGenericRuntimeExecutable(execPath)) {
    return { command: execPath, prefixArgs: [] };
  }
  const bundled = resolveBundledPiCli();
  if (bundled) {
    return { command: execPath, prefixArgs: [bundled] };
  }
  return { command: "pi", prefixArgs: [] };
}`
const PATCHED = `function resolvePiInvocation() {
  const configuredPiBinary = process.env.${ENVIRONMENT_VARIABLE}?.trim();
  if (configuredPiBinary) {
    if (!existsSync3(configuredPiBinary)) {
      throw new Error(\`Configured Magic Context Pi binary does not exist: \${configuredPiBinary}\`);
    }
    return { command: configuredPiBinary, prefixArgs: [] };
  }
  const execPath = process.execPath;
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
  if (currentScript && !isBunVirtualScript && existsSync3(currentScript) && isPiCliScript(currentScript)) {
    return { command: execPath, prefixArgs: [currentScript] };
  }
  if (!isGenericRuntimeExecutable(execPath)) {
    return { command: execPath, prefixArgs: [] };
  }
  const bundled = resolveBundledPiCli();
  if (bundled) {
    return { command: execPath, prefixArgs: [bundled] };
  }
  return { command: "pi", prefixArgs: [] };
}`

function usage() {
  throw new Error('Usage: patch-magic-context-electron.mjs <package-root> <absolute-pi-executable>')
}

async function main() {
  const packageRootArgument = process.argv[2]
  const piExecutableArgument = process.argv[3]
  if (packageRootArgument === undefined || piExecutableArgument === undefined) usage()

  const packageRoot = resolve(packageRootArgument)
  const piExecutable = resolve(piExecutableArgument)
  await access(piExecutable, constants.X_OK)

  const manifestPath = join(packageRoot, 'package.json')
  const distPath = join(packageRoot, 'dist/index.js')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version !== EXPECTED_VERSION) {
    throw new Error(`Magic Context package must be exactly ${EXPECTED_VERSION}; found ${String(manifest.version)}`)
  }

  const source = await readFile(distPath, 'utf8')
  let patchedSource = source
  if (source.includes(PATCHED)) {
    if (source.includes(ORIGINAL)) {
      throw new Error('Magic Context resolver contains both patched and original implementations')
    }
  } else {
    const occurrences = source.split(ORIGINAL).length - 1
    if (occurrences !== 1) {
      throw new Error(`Expected exactly one unpatched Magic Context resolver; found ${occurrences}`)
    }
    patchedSource = source.replace(ORIGINAL, PATCHED)
    await writeFile(distPath, patchedSource, 'utf8')
  }

  const functionStart = patchedSource.indexOf('function resolvePiInvocation() {')
  const functionEnd = patchedSource.indexOf('\nfunction resolveSiblingEntryPath', functionStart)
  if (functionStart < 0 || functionEnd < 0) {
    throw new Error('Unable to isolate patched Magic Context invocation resolver')
  }
  const functionSource = patchedSource.slice(functionStart, functionEnd)
  const resolveInvocation = new Function(
    'process',
    'existsSync3',
    'isPiCliScript',
    'isGenericRuntimeExecutable',
    'resolveBundledPiCli',
    `${functionSource}\nreturn resolvePiInvocation();`
  )
  const invocation = resolveInvocation(
    {
      env: { [ENVIRONMENT_VARIABLE]: piExecutable },
      execPath: '/opt/electron/electron',
      argv: ['/opt/electron/electron', '.']
    },
    (candidate) => candidate === piExecutable,
    () => { throw new Error('Pi CLI script inference must not run when the explicit override is set') },
    () => { throw new Error('Runtime inference must not run when the explicit override is set') },
    () => { throw new Error('Bundled CLI inference must not run when the explicit override is set') }
  )
  if (
    invocation === null || typeof invocation !== 'object' ||
    invocation.command !== piExecutable ||
    !Array.isArray(invocation.prefixArgs) || invocation.prefixArgs.length !== 0
  ) {
    throw new Error(`Patched Magic Context resolver returned an unexpected invocation: ${JSON.stringify(invocation)}`)
  }

  process.stdout.write(`Magic Context ${EXPECTED_VERSION} Electron adapter verified: ${piExecutable}\n`)
}

await main()
