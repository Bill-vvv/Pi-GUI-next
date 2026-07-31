import type { KernelInstalledPackage } from '../../../../shared/kernel-contract'

export function findUniqueInstalledPackage(
  packages: readonly KernelInstalledPackage[],
  packageName: string
): KernelInstalledPackage | null {
  const matches = packages.filter((pkg) => pkg.packageName === packageName)
  if (matches.length > 1) {
    throw new Error(`Multiple configured PackageSource entries resolve to ${packageName}.`)
  }
  return matches[0] ?? null
}
