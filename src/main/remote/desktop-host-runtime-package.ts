import { createRequire } from 'node:module'
import { access, cp, lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { desktopHostFilesDigest } from './desktop-host-deployment.ts'

const PACKAGE_NAME = /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/u
type PackageManifest = {
  name?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}
export type HostRuntimePackagePlan = {
  root: string; packages: string[]; links: Array<{ path: string; target: string }>;
  extensions: string[]; missingOptional: Array<{ from: string; name: string }>;
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../'))
}

/** Resolve declarations without executing package code or consulting global packages. */
export async function planHostRuntimePackages(buildRoot: string): Promise<HostRuntimePackagePlan> {
  const root = await realpath(buildRoot)
  const application = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const packages = new Set<string>(), links = new Map<string, string>()
  const missingOptional: HostRuntimePackagePlan['missingOptional'] = []
  const extensions = [...new Set<string>(application.build.extraResources.map((entry: { from: string }) => {
    const parts = entry.from.split('/')
    if (parts[0] !== 'extensions' || !PACKAGE_NAME.test(parts[1] ?? '') || parts.slice(1).some(part => !part || part === '..' || part === '.')) throw new Error('Unsupported Host runtime resource path.')
    return `extensions/${parts[1]}`
  }))].sort()
  const visitDependency = async (from: string, name: string, optional: boolean): Promise<void> => {
    if (!PACKAGE_NAME.test(name) || name === '.' || name === '..') throw new Error('Invalid runtime dependency name.')
    // A synthetic non-builtin asks Node for its real module search directories,
    // including nested and peer layouts, without package.json export restrictions.
    const search = createRequire(join(from, 'package.json')).resolve.paths('__pi_host_dependency__') ?? []
    let logical: string | undefined
    for (const directory of search) {
      const candidate = join(directory, name)
      if (!inside(root, candidate)) continue
      try { await access(join(candidate, 'package.json')); logical = candidate; break }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (logical === undefined) {
      if (optional) { missingOptional.push({ from: relative(root, from), name }); return }
      throw new Error(`Required runtime dependency is missing: ${name} from ${relative(root, from) || 'application'}`)
    }
    const target = await realpath(logical)
    if (!inside(root, target)) throw new Error(`Runtime dependency leaves the build: ${name}`)
    if (logical !== target) links.set(relative(root, logical), relative(root, target))
    if (packages.has(target)) return
    if (packages.size >= 4096) throw new Error('Too many runtime packages.')
    packages.add(target)
    await visitManifest(target, JSON.parse(await readFile(join(target, 'package.json'), 'utf8')))
  }
  const visitManifest = async (from: string, manifest: PackageManifest): Promise<void> => {
    for (const [name] of Object.entries(manifest.dependencies ?? {})) await visitDependency(from, name, Object.hasOwn(manifest.optionalDependencies ?? {}, name))
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) if (!Object.hasOwn(manifest.dependencies ?? {}, name)) await visitDependency(from, name, true)
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      if (!Object.hasOwn(manifest.dependencies ?? {}, name) && !Object.hasOwn(manifest.optionalDependencies ?? {}, name)) {
        await visitDependency(from, name, manifest.peerDependenciesMeta?.[name]?.optional === true)
      }
    }
  }
  await visitManifest(root, application)
  await visitDependency(root, 'electron', false)
  for (const extension of extensions) {
    let manifest: PackageManifest
    try { manifest = JSON.parse(await readFile(join(root, extension, 'package.json'), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    await visitManifest(join(root, extension), manifest)
  }
  return { root, packages: [...packages].map(path => relative(root, path)).sort(),
    links: [...links].map(([path, target]) => ({ path, target })).sort((a, b) => a.path.localeCompare(b.path)), extensions, missingOptional }
}

/** Preserve each selected package's contents and relative dependency bindings. */
export async function copyHostRuntimePackages(plan: HostRuntimePackagePlan, destination: string): Promise<void> {
  if (!isAbsolute(destination) || inside(plan.root, resolve(destination)) || inside(resolve(destination), plan.root)) throw new Error('Runtime package output must be separate from the source.')
  destination = join(await realpath(dirname(destination)), basename(destination))
  if (inside(plan.root, destination) || inside(destination, plan.root)) throw new Error('Runtime package output must be separate from the source.')
  await mkdir(destination, { recursive: true })
  destination = await realpath(destination)
  if (inside(plan.root, destination) || inside(destination, plan.root)) throw new Error('Runtime package output must be separate from the source.')
  await mkdir(join(destination, 'node_modules'), { recursive: true })
  await mkdir(join(destination, 'extensions'), { recursive: true })
  for (const path of [...plan.extensions, ...plan.packages]) {
    const source = join(plan.root, path), target = join(destination, path)
    if (!(await lstat(source)).isDirectory()) throw new Error(`Runtime package is not a directory: ${path}`)
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false,
      filter: entry => entry !== join(source, 'node_modules') })
  }
  for (const link of plan.links) {
    const path = join(destination, link.path), target = join(destination, link.target)
    await mkdir(dirname(path), { recursive: true })
    await symlink(relative(dirname(path), target), path)
  }
}

export function hostRuntimePackageDigest(plan: HostRuntimePackagePlan, root = plan.root): Promise<string> {
  const directories = [...plan.extensions, ...plan.packages]
  return desktopHostFilesDigest(root, [...directories, ...plan.links.map(link => link.path)], directories.map(path => `${path}/node_modules`))
}
