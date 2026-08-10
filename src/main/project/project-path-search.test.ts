import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'

import {
  PROJECT_PATH_SEARCH_UNAVAILABLE_CODE,
  searchProjectPaths
} from './project-path-search.ts'

const linuxTest = process.platform === 'linux' ? test : test.skip

async function makeProject(t: test.TestContext, prefix: string): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(projectPath, { recursive: true, force: true }))
  return projectPath
}

test('fails fast on platforms without descriptor-pinned no-follow traversal', async () => {
  for (const [platform, projectPath] of [
    ['win32', 'C:\\Projects\\pi-gui-next'],
    ['darwin', '/Users/tester/Projects/pi-gui-next']
  ] as const) {
    await assert.rejects(
      searchProjectPaths({ projectPath, query: '', platform }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal((error as NodeJS.ErrnoException).code, PROJECT_PATH_SEARCH_UNAVAILABLE_CODE)
        assert.match(error.message, new RegExp(`unavailable on ${platform}`, 'u'))
        return true
      }
    )
  }
})

linuxTest('fuzzy matching is case-insensitive, ordered, deterministic, and capped at 100', async (t) => {
  const projectPath = await makeProject(t, 'pi-gui-path-search-fuzzy-')
  await Promise.all([
    writeFile(join(projectPath, 'AlphaBeta.txt'), ''),
    writeFile(join(projectPath, 'a-long-b-gap.txt'), ''),
    mkdir(join(projectPath, 'docs')),
    ...Array.from({ length: 110 }, (_, index) =>
      writeFile(join(projectPath, `item-${String(index).padStart(3, '0')}.txt`), '')
    )
  ])

  assert.deepEqual(
    await searchProjectPaths({ projectPath, query: 'AB' }),
    [
      { path: 'AlphaBeta.txt', kind: 'file' },
      { path: 'a-long-b-gap.txt', kind: 'file' }
    ]
  )

  const first = await searchProjectPaths({ projectPath, query: '' })
  const second = await searchProjectPaths({ projectPath, query: '' })
  assert.equal(first.length, 100)
  assert.deepEqual(first, second)
  assert.deepEqual(first.slice(0, 2), [
    { path: 'AlphaBeta.txt', kind: 'file' },
    { path: 'a-long-b-gap.txt', kind: 'file' }
  ])
})

linuxTest('root and nested ignore files apply in order with negation', async (t) => {
  const projectPath = await makeProject(t, 'pi-gui-path-search-ignore-')
  await mkdir(join(projectPath, 'nested', 'ignored-dir'), { recursive: true })
  await Promise.all([
    writeFile(join(projectPath, '.gitignore'), '*.tmp\nroot-only.txt\nnested/*.log\nnested/ignored-dir/\n'),
    writeFile(join(projectPath, '.ignore'), '!visible.tmp\n'),
    writeFile(join(projectPath, 'hidden.tmp'), ''),
    writeFile(join(projectPath, 'visible.tmp'), ''),
    writeFile(join(projectPath, 'root-only.txt'), ''),
    writeFile(join(projectPath, 'nested', '.gitignore'), '*.secret\n'),
    writeFile(join(projectPath, 'nested', '.ignore'), '!keep.secret\n!keep.log\n!ignored-dir/child.txt\n'),
    writeFile(join(projectPath, 'nested', 'drop.secret'), ''),
    writeFile(join(projectPath, 'nested', 'keep.secret'), ''),
    writeFile(join(projectPath, 'nested', 'drop.log'), ''),
    writeFile(join(projectPath, 'nested', 'keep.log'), ''),
    writeFile(join(projectPath, 'nested', 'ignored-dir', 'child.txt'), '')
  ])

  const paths = (await searchProjectPaths({ projectPath, query: '' })).map(({ path }) => path)
  assert.equal(paths.includes('hidden.tmp'), false)
  assert.equal(paths.includes('visible.tmp'), true)
  assert.equal(paths.includes('root-only.txt'), false)
  assert.equal(paths.includes('nested/drop.secret'), false)
  assert.equal(paths.includes('nested/keep.secret'), true)
  assert.equal(paths.includes('nested/drop.log'), false)
  assert.equal(paths.includes('nested/keep.log'), true)
  assert.equal(paths.some((path) => path.startsWith('nested/ignored-dir')), false)
})

linuxTest('.git is excluded, hidden files remain searchable, symlinks are skipped, and kinds are accurate', async (t) => {
  const projectPath = await makeProject(t, 'pi-gui-path-search-safety-')
  const externalPath = await mkdtemp(join(tmpdir(), 'pi-gui-path-search-external-'))
  t.after(() => rm(externalPath, { recursive: true, force: true }))
  await mkdir(join(projectPath, '.git'))
  await mkdir(join(projectPath, 'folder'))
  await writeFile(join(projectPath, '.hidden'), '')
  await writeFile(join(projectPath, 'plain.txt'), '')
  await writeFile(join(projectPath, 'unsafe\nname.txt'), '')
  await writeFile(join(projectPath, '.git', 'config'), '')
  await writeFile(join(externalPath, 'outside.txt'), '')
  await symlink(join(projectPath, 'folder'), join(projectPath, 'internal-link'))
  await symlink(externalPath, join(projectPath, 'external-link'))

  const matches = await searchProjectPaths({ projectPath, query: '' })
  assert.deepEqual(matches, [
    { path: '.hidden', kind: 'file' },
    { path: 'folder', kind: 'directory' },
    { path: 'plain.txt', kind: 'file' }
  ])
})

linuxTest('query and limit validation fail fast and a canonical absolute root is required', async (t) => {
  const projectPath = await makeProject(t, 'pi-gui-path-search-validation-')
  const aliasPath = `${projectPath}-alias`
  await symlink(projectPath, aliasPath)
  t.after(() => rm(aliasPath, { force: true }))

  await assert.rejects(
    searchProjectPaths({ projectPath: relative(process.cwd(), projectPath), query: '' }),
    /absolute/
  )
  await assert.rejects(searchProjectPaths({ projectPath: aliasPath, query: '' }), /canonically/)
  await assert.rejects(searchProjectPaths({ projectPath, query: '\u0000' }), /control/)
  await assert.rejects(searchProjectPaths({ projectPath, query: '\n' }), /control/)
  await assert.rejects(searchProjectPaths({ projectPath, query: 'x'.repeat(257) }), /256/)
  await assert.rejects(searchProjectPaths({ projectPath, query: '', limit: 0 }), /1 to 100/)
  await assert.rejects(searchProjectPaths({ projectPath, query: '', limit: 101 }), /1 to 100/)
  await assert.rejects(searchProjectPaths({ projectPath, query: '', limit: 1.5 }), /integer/)
})

linuxTest('ordinary file contents are never surfaced and malformed ignore files fail fast', async (t) => {
  const projectPath = await makeProject(t, 'pi-gui-path-search-content-')
  await writeFile(join(projectPath, 'innocent-name.txt'), 'DO_NOT_SURFACE_THIS_SECRET')
  assert.deepEqual(
    await searchProjectPaths({ projectPath, query: 'DO_NOT_SURFACE_THIS_SECRET' }),
    []
  )

  await writeFile(join(projectPath, '.gitignore'), Buffer.from([0xff]))
  await assert.rejects(
    searchProjectPaths({ projectPath, query: '' }),
    /Invalid UTF-8 in project ignore file/
  )
})
