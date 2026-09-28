import { constants } from 'node:fs'
import { open, opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, matchesGlob, parse, relative, resolve, sep } from 'node:path'

import { isDesktopSshHostAlias, type DesktopSshHostListing } from '../../shared/desktop-client-contract.ts'

type ConfigRoot = { filePath: string; includeBase: string }
const MAX_BYTES = 1024 * 1024
const MAX_FILES = 64
const MAX_DEPTH = 8
const MAX_ENTRIES = 4096
const MAX_HOSTS = 256

/** Inventory only: never run ssh -G, Match exec, ProxyCommand, or inspect key files. */
export async function discoverSystemSshHosts(): Promise<DesktopSshHostListing> {
  if (process.platform !== 'win32') throw new Error('SSH 主机发现仅用于 Windows SSH 客户端。')
  const programData = process.env.ProgramData
  if (!programData || !isAbsolute(programData)) throw new Error('缺少有效的 Windows ProgramData 路径。')
  const home = homedir()
  return discoverSshHosts([
    { filePath: join(home, '.ssh', 'config'), includeBase: join(home, '.ssh') },
    { filePath: join(programData, 'ssh', 'ssh_config'), includeBase: join(programData, 'ssh') }
  ], home)
}

export async function discoverSshHosts(roots: ConfigRoot[], home: string): Promise<DesktopSshHostListing> {
  const result: DesktopSshHostListing = { hosts: [], searchedFiles: roots.map((root) => root.filePath), warnings: [] }
  const aliases = new Set<string>()
  const warnings = new Set<string>()
  const stack = new Set<string>()
  let fileCount = 0
  let byteCount = 0
  let entryCount = 0
  const warn = (message: string): void => {
    if (warnings.size >= 100) throw new Error('SSH 配置诊断超过 100 条，请整理配置后重试。')
    warnings.add(message)
  }

  async function expand(pattern: string): Promise<string[]> {
    if (!/[*?[]/u.test(pattern)) return [pattern]
    const root = parse(pattern).root
    let paths = [root]
    for (const segment of relative(root, pattern).split(sep)) {
      const next: string[] = []
      for (const parent of paths) {
        if (!/[*?[]/u.test(segment)) { next.push(join(parent, segment)); continue }
        let directory
        try { directory = await opendir(parent) } catch (error) {
          if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') continue
          throw new Error(`无法扫描 SSH Include 目录 ${parent}（${errorCode(error)}）。`)
        }
        for await (const entry of directory) {
          if (++entryCount > MAX_ENTRIES) throw new Error('SSH Include 扫描超过 4096 个目录项。')
          if (matchesGlob(entry.name, segment)) next.push(join(parent, entry.name))
        }
      }
      paths = next
    }
    return paths.sort()
  }

  async function visit(filePath: string, includeBase: string, depth: number, optional: boolean): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error('SSH Include 嵌套超过 8 层。')
    if (++fileCount > MAX_FILES) throw new Error('SSH 配置读取超过 64 个文件。')
    let canonical: string
    try { canonical = await realpath(filePath) } catch (error) {
      if (optional && errorCode(error) === 'ENOENT') return
      warn(`无法读取 SSH 配置 ${filePath}（${errorCode(error)}）。`)
      return
    }
    if (stack.has(canonical)) { warn(`SSH Include 存在循环：${filePath}`); return }
    let text: string
    try {
      const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        if (!(await file.stat()).isFile()) { warn(`SSH 配置不是普通文件：${filePath}`); return }
        const buffer = Buffer.alloc(MAX_BYTES - byteCount + 1)
        let offset = 0
        while (offset < buffer.length) {
          const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null)
          if (bytesRead === 0) break
          offset += bytesRead
        }
        byteCount += offset
        if (byteCount > MAX_BYTES) throw new DiscoveryLimitError('SSH 配置总大小超过 1 MiB。')
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))
      } finally { await file.close() }
    } catch (error) {
      if (error instanceof DiscoveryLimitError) throw error
      warn(`无法读取 UTF-8 SSH 配置 ${filePath}（${errorCode(error)}）。`)
      return
    }
    stack.add(canonical)
    try {
      const lines = text.split(/\r?\n/u)
      for (let index = 0; index < lines.length; index++) {
        const directive = /^\s*(Host|Include|Match)(?:\s*=\s*|\s+|$)(.*)$/iu.exec(lines[index]!)
        if (!directive) continue
        const location = `${filePath}:${index + 1}`
        const keyword = directive[1]!.toLowerCase()
        if (keyword === 'match') {
          warn('配置包含 Match 条件；发现结果仅为静态候选，未执行条件命令。')
          continue
        }
        const tokens = tokenize(directive[2]!)
        if (tokens === null || tokens.length === 0) { warn(`SSH ${keyword} 声明格式无效：${location}`); continue }
        if (keyword === 'host') {
          for (const alias of tokens) {
            if (/^[!]|[*?]/u.test(alias)) continue
            if (!isDesktopSshHostAlias(alias)) { warn(`存在客户端不支持的 SSH 别名：${location}`); continue }
            if (aliases.has(alias)) continue
            if (aliases.size >= MAX_HOSTS) throw new DiscoveryLimitError('SSH 主机候选超过 256 个。')
            aliases.add(alias)
            result.hosts.push({ alias, filePath, line: index + 1 })
          }
        } else {
          for (const token of tokens) {
            // Do not substitute environment/runtime tokens or implement another shell/glob language.
            if (/[%$`{}()]|\*\*/u.test(token) || (token.startsWith('~') && !/^~[/\\]/u.test(token))) {
              warn(`SSH Include 含未支持的动态路径或模式：${location}`)
              continue
            }
            const expandedHome = /^~[/\\]/u.test(token) ? join(home, token.slice(2)) : token
            const pattern = resolve(includeBase, expandedHome)
            const paths = await expand(pattern)
            if (paths.length === 0) warn(`SSH Include 未匹配到文件：${location}`)
            for (const path of paths) await visit(path, includeBase, depth + 1, false)
          }
        }
      }
    } finally { stack.delete(canonical) }
  }

  for (const root of roots) await visit(root.filePath, root.includeBase, 0, true)
  result.warnings = [...warnings]
  return result
}

// SSH configuration quoting, not shell evaluation. Preserve ordinary Windows backslashes.
function tokenize(value: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (char === '\\' && (value[index + 1] === '"' || value[index + 1] === '\\')) {
      current += value[++index]
    } else if (char === '"') {
      quote = !quote
    } else if (!quote && (char === '#' || /\s/u.test(char))) {
      if (current.length > 0) { tokens.push(current); current = '' }
      if (char === '#') break
    } else current += char
  }
  if (quote) return null
  if (current.length > 0) tokens.push(current)
  return tokens
}

class DiscoveryLimitError extends Error {}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : '格式或读取错误'
}
