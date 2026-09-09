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
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false }
})
after(() => vite.close())

const module = await vite.ssrLoadModule(
  '/src/renderer/src/features/git/GitChangesPanel.tsx'
) as typeof import('./GitChangesPanel.tsx')
const source = await readFile(new URL('./GitChangesPanel.tsx', import.meta.url), 'utf8')
const diffViewerSource = await readFile(new URL('./GitDiffViewer.tsx', import.meta.url), 'utf8')
const historyPanelSource = await readFile(new URL('./GitHistoryPanel.tsx', import.meta.url), 'utf8')
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
  assert.match(source, /window\.piGit\.prepareCommit\(requestProjectKey\)/)
  assert.match(source, /window\.piGit\.executeCommit\(requestProjectKey/)
  assert.match(source, /window\.piGit\.prepareBranchSync\(requestProjectKey\)/)
  assert.match(source, /window\.piGit\.executeBranchSync\(requestProjectKey, request\)/)
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
  assert.match(source, /import \{ GitDiffViewer, type GitDiffViewerResult \} from '\.\/GitDiffViewer'/)
  assert.match(source, /<GitDiffViewer result=\{expanded\.result\} \/>/)
  assert.match(diffViewerSource, /\{line\.content\}/)
  assert.match(diffViewerSource, /buildGitDiffRenderRows\(result\.files\)/)
  assert.match(diffViewerSource, /\{row\.unmodifiedLines\} unmodified lines/)
  assert.doesNotMatch(diffViewerSource, /\{hunk\.header\}/)
  assert.doesNotMatch(diffViewerSource, /dangerouslySetInnerHTML|innerHTML|react-markdown|MarkdownMessage/)
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
  assert.match(source, /import \{ GitDiffViewer, type GitDiffViewerResult \} from '\.\/GitDiffViewer'/)
  assert.match(diffViewerSource, /from '@tanstack\/react-virtual'/)
  assert.match(diffViewerSource, /export const GIT_DIFF_VIRTUALIZE_AFTER_ROWS = 300/)
  assert.match(diffViewerSource, /rows\.length > GIT_DIFF_VIRTUALIZE_AFTER_ROWS/)
  assert.match(diffViewerSource, /data-virtualized="false"/)
  assert.match(diffViewerSource, /useVirtualizer\(\{/)
  assert.match(diffViewerSource, /estimateSize: \(\) => GIT_DIFF_ROW_HEIGHT/)
  assert.match(diffViewerSource, /overscan: GIT_DIFF_OVERSCAN/)
  assert.match(diffViewerSource, /virtualizer\.getVirtualItems\(\)/)
  assert.match(diffViewerSource, /gitDiffRenderRowsMaxColumns\(rows\)/)
  assert.match(diffViewerSource, /gitDiffRenderRowsText\(rows\)/)
  assert.match(diffViewerSource, /查看完整文本/)
  assert.match(diffViewerSource, /复制全部/)
  assert.match(diffViewerSource, /width: `max\(100%, calc\(\$\{maximumColumns\}ch \+ 8\.5em\)\)`/)
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

test('P3-2 commit remains a fenced confirmation flow beside later read/write Git slices', () => {
  assert.match(source, /P3-1 不提供 diff、暂存或冲突解决/)
  assert.match(source, /gitActionsForScope\(file, scope\)/)
  assert.match(source, /Commit & Push/)
  assert.match(source, /<GitCommitDialog/)
  assert.match(source, /snapshot: active\.preview\.snapshot/)
  assert.match(source, /expectedPushTarget: active\.preview\.pushTarget/)
  assert.match(source, /active\.result\?\.commit\.status === 'succeeded'/)
  assert.equal(source.match(/window\.piGit\.executeCommit\(/g)?.length, 1)
  assert.doesNotMatch(source, /cherry-pick|rebase|force push|--force|setUpstream/)
  assert.doesNotMatch(source, /stderrCharacters/)
})

test('P3-4 prepares and executes Branches & Sync through Parent-owned identity fences', () => {
  assert.match(source, /branchPrepareTokenRef/)
  assert.match(source, /branchExecuteTokenRef/)
  assert.match(source, /branchSnapshotRef/)
  assert.match(source, /gitBranchSyncSnapshotMatchesState/)
  assert.match(source, /mapGitBranchSyncPrepareResult/)
  assert.match(source, /buildGitBranchSyncExecutionRequest/)
  assert.match(source, /mapGitBranchSyncExecutionResult/)
  assert.match(source, /response\.result\.action !== expectedAction/)
  assert.match(source, /gitBranchSyncExecutionMatchesPreview\(response\.result, dialog\.preview, payload, snapshot\)/)
  assert.match(source, /requestToken !== branchExecuteTokenRef\.current/)
  assert.match(source, /<GitBranchesPanel/)
  assert.match(source, /branchDialog !== null/)
  assert.equal(source.match(/window\.piGit\.prepareBranchSync\(/g)?.length, 1)
  assert.equal(source.match(/window\.piGit\.executeBranchSync\(/g)?.length, 1)
})

test('Git tab hosts an internal accessible Changes/History/Branches tabset without a second sidebar module', () => {
  assert.match(source, /role="tablist"/)
  assert.match(source, /aria-label="Git 子视图"/)
  assert.match(source, /role="tab"/)
  assert.match(source, /role="tabpanel"/)
  assert.match(source, /GIT_HISTORY_SUBVIEWS/)
  assert.match(source, /gitPanelSubviewFromKey/)
  assert.match(source, /tabIndex=\{selected \? 0 : -1\}/)
  assert.match(source, /selectSubviewFromKeyboard/)
  assert.match(source, /import \{ GitHistoryPanel \} from '\.\/GitHistoryPanel'/)
  assert.match(source, /import \{ GitBranchesPanel \} from '\.\/GitBranchesPanel'/)
  assert.match(source, /createEmptyGitHistoryDraft/)
  assert.match(source, /candidate === 'history' \? 'History' : 'Branches'/)
  assert.equal(source.match(/window\.piGit\.listHistory\(/g)?.length, 1)
  assert.equal(source.match(/window\.piGit\.getHistoryDetail\(/g)?.length, 1)
  assert.equal(source.match(/window\.piGit\.getHistoryFileDiff\(/g)?.length, 1)
  assert.match(source, /snapshot,\s*oid,\s*fileId/)
  assert.doesNotMatch(historyPanelSource, /window\.piGit/)
  assert.doesNotMatch(historyPanelSource, /stageFile|unstageFile|prepareCommit|executeCommit|Commit & Push/)
  assert.match(styles, /\.git-subview-tabs[\s\S]*?role|\.git-subview-tab/)
  assert.match(styles, /\.git-history-/)
})

test('History activation, refresh, pagination and file-diff identities stay fenced in Parent state', () => {
  assert.match(source, /historySnapshotRef\.current = snapshot/)
  assert.match(source, /if \(subview !== 'history' \|\| historySnapshotRef\.current !== null\) return/)
  assert.match(source, /if \(snapshot !== null\) activateHistory\(false\)/)
  assert.doesNotMatch(source, /activateHistory\(true\)/)
  assert.match(source, /result\.offset !== offset/)
  assert.match(source, /result\.commits\.length > GIT_HISTORY_PAGE_SIZE/)
  assert.match(source, /nextOffset,\s*hasMore/)
  assert.match(source, /historyDraft\.nextOffset/)
  assert.match(source, /response\.result\.oid !== oid/)
  assert.match(source, /response\.result\.fileId !== fileId/)
  assert.match(source, /response\.result\.originalPath === file\.originalPath/)
  assert.match(source, /const seenOids = new Set/)
  assert.match(source, /if \(seenOids\.has\(commit\.oid\)\) return false/)
})

test('commit result mapping keeps partial success and landed warnings independent', () => {
  const mapped = module.buildGitCommitDialogResult({
    mode: 'commit-and-push',
    commit: {
      status: 'succeeded',
      oid: 'a'.repeat(40),
      warnings: ['command-error-after-landing', 'confirmed-snapshot-diverged']
    },
    push: {
      status: 'failed',
      remote: 'origin',
      branch: 'main',
      error: { code: 'git-error', message: 'Git operation failed.', stderrCharacters: 12 }
    },
    postState: {
      ok: false,
      error: { code: 'timeout', message: 'Git operation timed out.', stderrCharacters: 0 }
    }
  })
  assert.equal(mapped.commit.status, 'succeeded')
  assert.match(mapped.commit.detail ?? '', /不会重复提交/)
  assert.match(mapped.commit.detail ?? '', /Hook 改变了最终 commit 内容/)
  assert.equal(mapped.push.status, 'failed')
  assert.equal(mapped.push.detail, 'Git operation failed.')
  assert.equal(mapped.refresh?.status, 'failed')
})
