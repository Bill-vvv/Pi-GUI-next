import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const vite = await createServer({
  configFile: false,
  root: new URL('../../../../../', import.meta.url).pathname,
  appType: 'custom',
  server: { middlewareMode: true, hmr: false }
})
after(() => vite.close())

const module = await vite.ssrLoadModule(
  '/src/renderer/src/features/git/GitChangesPanel.tsx'
) as typeof import('./GitChangesPanel.tsx')
const source = await readFile(new URL('./GitChangesPanel.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('./git-changes.css', import.meta.url), 'utf8')

test('GitChangesPanel exports a narrow project-owned integration contract and SSR loading state', () => {
  const html = renderToStaticMarkup(createElement(module.GitChangesPanel, { projectKey: 'project-a' }))
  assert.match(html, /Git Changes/)
  assert.match(html, /刷新 Git 状态/)
  assert.match(html, /正在刷新 Git 状态/)
  assert.match(html, /aria-labelledby=/)
})

test('renderer uses only the existing piGit bridge with generation and project response fences', () => {
  assert.match(source, /window\.piGit\.refresh\(requestProjectKey\)/)
  assert.match(source, /window\.piGit\.authorizeAncestorRepository/)
  assert.match(source, /window\.piGit\.getDiff/)
  assert.match(source, /window\.piGit\.stageFile/)
  assert.match(source, /window\.piGit\.unstageFile/)
  assert.match(source, /isCurrentGitResponse\(/)
  assert.match(source, /response\.projectKey/)
  assert.match(source, /requestProjectKey !== projectKey \|\|[\s\S]*?requestGeneration !== generationRef\.current/)
  assert.match(source, /loading: false, error: RENDERER_GIT_INVOCATION_ERROR/)
  assert.doesNotMatch(source, /setInterval|watcher|polling/)
  assert.equal(source.match(/window\.setTimeout\(/g)?.length, 1)
  assert.match(source, /const GIT_DIFF_PREFETCH_DELAY_MS = 80/)
})

test('Cursor-style scope control keeps files collapsed by default and renders compact scoped rows', () => {
  assert.match(source, /const \[scope, setScope\] = useState<GitChangeScope>\('all'\)/)
  assert.match(source, /useState<ReadonlyMap<string, ExpandedDiff>>\(\(\) => new Map\(\)\)/)
  assert.match(source, /\(\['all', 'unstaged', 'staged'\] as const\)/)
  assert.match(source, /<Select[\s\S]*?value=\{scope\}[\s\S]*?onScopeChange\(value as GitChangeScope\)/)
  assert.match(source, /clearExpandedDiffs\(\)[\s\S]*?setScope\(nextScope\)/)
  assert.match(source, /visibleFiles\.map/)
  assert.match(source, /gitDiffKindsForScope\(file, scope\)/)
  assert.match(source, /gitActionsForScope\(file, scope\)/)
  assert.match(source, /name=\{isExpanded \? 'chevron-down' :\s*'chevron-right'\}/)
  assert.match(source, /icon=\{action === 'stage' \? 'plus' :\s*'undo'\}/)
  assert.doesNotMatch(source, /Last Turn|Branch Commits|\+[0-9]+\s+-[0-9]+/)
  assert.doesNotMatch(styles, /\.git-conflict-explanation/)
})

test('file diffs expand independently and the heading owns one real collapse-all control', () => {
  assert.match(source, /const requestEpoch = diffEpochRef\.current/)
  assert.match(source, /setBoundedGitDiffEntry\(current, fileSnapshot\.id, \{[\s\S]*?loading: true/)
  assert.match(source, /expandedDiffs\.get\(file\.id\) \?\? null/)
  assert.match(source, /icon="collapse-all"[\s\S]*?label="折叠全部文件 diff"/)
  assert.match(source, /disabled=\{expandedDiffs\.size === 0\}/)
  assert.match(source, /expandedDiffs\.size >= GIT_DIFF_MAX_EXPANDED_FILES/)
  assert.match(source, /最多同时展开 \$\{GIT_DIFF_MAX_EXPANDED_FILES\} 个文件 diff/)
  assert.match(source, /onCollapseAll=\{clearExpandedDiffs\}/)
  assert.doesNotMatch(source, /setExpanded\(null\)|expanded\?\.fileId/)
})

test('diff content remains plain React text and marks omitted unchanged ranges without inventing source lines', () => {
  assert.match(source, /\{line\.content\}/)
  assert.match(source, /buildGitDiffRenderRows\(result\.files\)/)
  assert.match(source, /\{row\.unmodifiedLines\} unmodified lines/)
  assert.doesNotMatch(source, /\{hunk\.header\}/)
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|react-markdown|MarkdownMessage/)
  assert.match(styles, /\.git-diff-scroll[\s\S]*?overflow: auto;/)
  assert.match(styles, /\.git-diff-fold[\s\S]*?position: sticky;/)
  assert.match(styles, /\.git-diff-line[\s\S]*?white-space: pre;/)
  assert.match(styles, /min-height: 32px/)
  assert.match(styles, /:focus-visible|button/)
})

test('intent prefetch is revision-bound, deduplicated and bounded instead of pre-rendering hidden diffs', () => {
  assert.match(source, /new GitDiffLruCache\(\)/)
  assert.match(source, /gitDiffCacheKey\(projectKey, snapshot, fileSnapshot, kind\)/)
  assert.match(source, /new GitDiffRequestPool<GitDiffBridgeResponse>\(\)/)
  assert.match(source, /diffRequestsRef\.current\.getOrCreate\(/)
  assert.match(source, /activePrefetchKeyRef\.current !== null/)
  assert.match(source, /onPointerEnter=\{\(\) =>[\s\S]*?onPrefetchFile/)
  assert.match(source, /onFocus=\{\(\) =>[\s\S]*?onPrefetchFile/)
  assert.match(source, /onBlur=\{\(event\) =>[\s\S]*?shouldCancelGitDiffPrefetch/)
  assert.match(source, /gitDiffResultInvalidatesSnapshot\(result, snapshot\)[\s\S]*?refreshInvalidatedSnapshot/)
  assert.match(source, /diffCacheRef\.current\.clear\(\)/)
})

test('large diffs virtualize after a fixed threshold while small diffs keep the simple path', () => {
  assert.match(source, /from '@tanstack\/react-virtual'/)
  assert.match(source, /const GIT_DIFF_VIRTUALIZE_AFTER_ROWS = 300/)
  assert.match(source, /rows\.length > GIT_DIFF_VIRTUALIZE_AFTER_ROWS/)
  assert.match(source, /data-virtualized="false"/)
  assert.match(source, /useVirtualizer\(\{/)
  assert.match(source, /estimateSize: \(\) => GIT_DIFF_ROW_HEIGHT/)
  assert.match(source, /overscan: GIT_DIFF_OVERSCAN/)
  assert.match(source, /virtualizer\.getVirtualItems\(\)/)
  assert.match(source, /gitDiffRenderRowsMaxColumns\(rows\)/)
  assert.match(source, /gitDiffRenderRowsText\(rows\)/)
  assert.match(source, /查看完整文本/)
  assert.match(source, /复制全部/)
  assert.match(source, /width: `max\(100%, calc\(\$\{maximumColumns\}ch \+ 8\.5em\)\)`/)
  assert.match(styles, /\.git-diff-scroll\.virtualized[\s\S]*?contain: strict;/)
  assert.match(styles, /\.git-diff-virtual-row[\s\S]*?position: absolute;[\s\S]*?width: 100%;/)
  assert.match(styles, /\.git-diff-scroll\.virtualized \.git-diff-line[\s\S]*?height: 32px;/)
  assert.match(styles, /\.git-diff-full-text[\s\S]*?height: 430px;/)
})

test('stale rendered callbacks are fenced before reads, cache hits and mutations', () => {
  assert.ok((source.match(/!isDisplayedGitSnapshot\(stateRef\.current, snapshot\)/g)?.length ?? 0) >= 5)
  assert.match(source, /requestEpoch !== diffEpochRef\.current \|\|[\s\S]*?!isDisplayedGitSnapshot\(stateRef\.current, snapshot\)/)
  assert.match(source, /const cached = diffCacheRef\.current\.get\(key\)/)
  assert.match(source, /const gitMutationGate = new GitMutationGate\(\)/)
  assert.match(source, /if \(!gitMutationGate\.tryAcquire\(gateKey\)\) return/)
  assert.match(source, /finally \{[\s\S]*?gitMutationGate\.release\(gateKey\)/)
})

test('stale trust and mutation paths refresh read-only state without replaying writes', () => {
  assert.match(source, /response\.result\.error\.code !== 'stale'[\s\S]*?await refreshState\(requestGeneration, false\)/)
  assert.match(source, /gitDiffResultInvalidatesSnapshot\(result, snapshot\)[\s\S]*?refreshInvalidatedSnapshot\(snapshot, requestGeneration\)/)
  assert.match(source, /const refreshFailure = await refreshState\(requestGeneration, false\)[\s\S]*?if \(mutationResult\.ok\)/)
  assert.equal(source.match(/window\.piGit\.(?:stageFile|unstageFile)\(/g)?.length, 2)
})

test('P3-1 UI excludes future Git operations and conflict mutation controls', () => {
  assert.match(source, /P3-1 不提供 diff、暂存或冲突解决/)
  assert.match(source, /gitActionsForScope\(file, scope\)/)
  assert.doesNotMatch(source, /Commit & Push|\bAmend\b|\bFetch\b|\bPull\b|cherry-pick|rebase/)
  assert.doesNotMatch(source, /stderrCharacters/)
})
