import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import type { GitDiffResult } from '../../../../shared/git-contract.ts'
import {
  createEmptyGitHistoryDraft,
  gitHistoryClearSelection,
  gitHistoryCommitAccessibleName,
  gitHistoryFileDisplayPath,
  gitHistoryListStatusText,
  gitHistorySelectCommit,
  gitHistoryShowsDetail,
  gitHistoryToggleExpandedFile,
  gitPanelSubviewFromKey,
  type GitHistoryDraftViewModel
} from './git-history-model.ts'

const vite = await createServer({
  configFile: false,
  root: new URL('../../../../../', import.meta.url).pathname,
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false }
})
after(() => vite.close())

const historyModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/git/GitHistoryPanel.tsx'
) as typeof import('./GitHistoryPanel.tsx')
const historySource = await readFile(new URL('./GitHistoryPanel.tsx', import.meta.url), 'utf8')
const historyModelSource = await readFile(new URL('./git-history-model.ts', import.meta.url), 'utf8')
const diffViewerSource = await readFile(new URL('./GitDiffViewer.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('./git-changes.css', import.meta.url), 'utf8')

const sampleCommit = {
  oid: 'a'.repeat(40),
  shortOid: 'aaaaaaaa',
  subject: 'Add history UI',
  authorName: 'Ada',
  authorEmail: 'ada@example.com',
  authoredAt: 1_700_000_000_000,
  committerName: 'Ada',
  committerEmail: 'ada@example.com',
  committedAt: 1_700_000_000_000,
  parentOids: ['b'.repeat(40)]
} as const

function readyList(view: Partial<GitHistoryDraftViewModel> = {}): GitHistoryDraftViewModel {
  return {
    ...createEmptyGitHistoryDraft(),
    listStatus: 'ready',
    commits: [sampleCommit],
    ...view
  }
}

test('internal subview keyboard navigation uses ArrowLeft/Right/Home/End with wraparound', () => {
  const tabs = ['changes', 'history'] as const
  assert.equal(gitPanelSubviewFromKey(tabs, 0, 'ArrowRight'), 'history')
  assert.equal(gitPanelSubviewFromKey(tabs, 1, 'ArrowRight'), 'changes')
  assert.equal(gitPanelSubviewFromKey(tabs, 0, 'ArrowLeft'), 'history')
  assert.equal(gitPanelSubviewFromKey(tabs, 1, 'ArrowLeft'), 'changes')
  assert.equal(gitPanelSubviewFromKey(tabs, 1, 'Home'), 'changes')
  assert.equal(gitPanelSubviewFromKey(tabs, 0, 'End'), 'history')
  assert.equal(gitPanelSubviewFromKey(tabs, 0, 'Enter'), null)
  assert.equal(gitPanelSubviewFromKey([], 0, 'ArrowRight'), null)
  assert.match(historyModelSource, /ArrowLeft/)
  assert.match(historyModelSource, /ArrowRight/)
  assert.match(historyModelSource, /Home/)
  assert.match(historyModelSource, /End/)
})

test('draft view model selects detail, returns to list, and keeps only one expanded file diff', () => {
  let draft = readyList()
  assert.equal(gitHistoryShowsDetail(draft), false)

  draft = gitHistorySelectCommit(draft, sampleCommit.oid)
  assert.equal(draft.selectedOid, sampleCommit.oid)
  assert.equal(draft.detailLoading, true)
  assert.equal(draft.expandedDiff, null)
  assert.equal(gitHistoryShowsDetail(draft), true)

  draft = {
    ...draft,
    detailLoading: false,
    detail: {
      commit: sampleCommit,
      message: 'Add history UI\n\nBody',
      messageTruncated: false,
      files: [
        { fileId: 'file-a', path: 'a.ts', originalPath: null, change: 'modified' },
        { fileId: 'file-b', path: 'b.ts', originalPath: null, change: 'added' }
      ],
      filesTruncated: true
    }
  }

  draft = gitHistoryToggleExpandedFile(draft, 'file-a')
  assert.equal(draft.expandedDiff?.fileId, 'file-a')
  assert.equal(draft.expandedDiff?.loading, true)

  draft = gitHistoryToggleExpandedFile(draft, 'file-b')
  assert.equal(draft.expandedDiff?.fileId, 'file-b')
  assert.notEqual(draft.expandedDiff?.fileId, 'file-a')

  draft = gitHistoryToggleExpandedFile(draft, 'file-b')
  assert.equal(draft.expandedDiff, null)

  const returned = gitHistoryClearSelection(draft)
  assert.equal(returned.selectedOid, null)
  assert.equal(returned.detail, null)
  assert.equal(returned.expandedDiff, null)
  assert.equal(gitHistoryShowsDetail(returned), false)
})

test('pure History panel renders list, truncation, detail metadata and reuses GitDiffViewer', () => {
  const listHtml = renderToStaticMarkup(createElement(historyModule.GitHistoryPanel, {
    view: readyList({ listTruncated: true, hasMore: true }),
    onSelectCommit() {},
    onLoadMore() {},
    onBack() {},
    onToggleFile() {}
  }))
  assert.match(listHtml, /提交历史/)
  assert.match(listHtml, /aaaaaaaa/)
  assert.match(listHtml, /Add history UI/)
  assert.match(listHtml, /安全上限/)
  assert.match(listHtml, /加载更多/)
  assert.match(listHtml, /aria-label="aaaaaaaa Add history UI"/)

  const emptyHtml = renderToStaticMarkup(createElement(historyModule.GitHistoryPanel, {
    view: createEmptyGitHistoryDraft(),
    onSelectCommit() {},
    onLoadMore() {},
    onBack() {},
    onToggleFile() {}
  }))
  assert.match(emptyHtml, /没有可显示的提交/)

  const errorHtml = renderToStaticMarkup(createElement(historyModule.GitHistoryPanel, {
    view: {
      ...createEmptyGitHistoryDraft(),
      listStatus: 'error',
      listError: 'boom'
    },
    onSelectCommit() {},
    onLoadMore() {},
    onBack() {},
    onToggleFile() {}
  }))
  assert.match(errorHtml, /boom/)
  assert.match(errorHtml, /role="alert"/)

  const readyDiff: GitDiffResult = {
    kind: 'working',
    path: 'a.ts',
    state: 'ready',
    revision: null,
    headOid: null,
    indexTreeOid: null,
    worktreeFingerprint: 'f'.repeat(64),
    files: [{
      id: 'file-a',
      path: 'a.ts',
      originalPath: null,
      change: 'modified',
      hunks: [{
        id: 'h1',
        header: '@@ -1 +1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [{ kind: 'add', oldLine: null, newLine: 1, content: 'hello' }]
      }]
    }],
    byteCount: 12,
    fileCount: 1,
    hunkCount: 1,
    lineCount: 1,
    error: null
  }

  const detailHtml = renderToStaticMarkup(createElement(historyModule.GitHistoryPanel, {
    view: readyList({
      selectedOid: sampleCommit.oid,
      detailLoading: false,
      detail: {
        commit: sampleCommit,
        message: 'Add history UI\n\nBody',
        messageTruncated: true,
        files: [
          { fileId: 'file-a', path: 'a.ts', originalPath: null, change: 'modified' },
          { fileId: 'file-b', path: 'old.ts', originalPath: 'old.ts', change: 'renamed' }
        ],
        filesTruncated: true
      },
      expandedDiff: {
        fileId: 'file-a',
        loading: false,
        result: readyDiff,
        error: null
      }
    }),
    onSelectCommit() {},
    onLoadMore() {},
    onBack() {},
    onToggleFile() {}
  }))
  assert.match(detailHtml, /返回提交列表/)
  assert.match(detailHtml, /完整提交说明/)
  assert.match(detailHtml, /提交说明已截断/)
  assert.match(detailHtml, /变更文件列表已达到安全上限/)
  assert.match(detailHtml, /hello/)
  assert.doesNotMatch(detailHtml, /Commit &amp; Push|暂存|取消暂存|Stage|Unstage/)
})

test('detail/back focus contract and history source stay pure without mutation or backend history bridges', () => {
  assert.match(historySource, /focusOidAfterBackRef/)
  assert.match(historySource, /backButtonRef/)
  assert.match(historySource, /commitButtonRefs/)
  assert.match(historySource, /onBack\(\)/)
  assert.match(historySource, /GitDiffViewer/)
  assert.doesNotMatch(historySource, /window\.piGit/)
  assert.doesNotMatch(historySource, /stageFile|unstageFile|prepareCommit|executeCommit/)
  assert.doesNotMatch(historySource, /Commit & Push|Stage|Unstage/)
  assert.doesNotMatch(historyModelSource, /window\.piGit/)
  assert.equal(
    gitHistoryCommitAccessibleName(sampleCommit),
    'aaaaaaaa Add history UI'
  )
  assert.equal(
    gitHistoryFileDisplayPath({
      fileId: '1',
      path: 'new.ts',
      originalPath: 'old.ts',
      change: 'renamed'
    }),
    'old.ts → new.ts'
  )
  assert.equal(gitHistoryListStatusText('loading', null), '正在读取提交历史…')
  assert.equal(gitHistoryListStatusText('stale', null), 'Repository 或 HEAD 已变化，请重新加载历史。')
})

test('GitDiffViewer remains the shared owner for virtualization, full-text mode and non-ready states', () => {
  assert.match(diffViewerSource, /export function GitDiffViewer/)
  assert.match(diffViewerSource, /export const GIT_DIFF_VIRTUALIZE_AFTER_ROWS = 300/)
  assert.match(diffViewerSource, /查看完整文本/)
  assert.match(diffViewerSource, /复制全部/)
  assert.match(diffViewerSource, /binary 或非 UTF-8/)
  assert.match(diffViewerSource, /超过安全显示上限/)
  assert.match(historySource, /import \{ GitDiffViewer \} from '\.\/GitDiffViewer'/)
})

test('history CSS covers narrow width, visible focus and reduced-motion', () => {
  assert.match(styles, /\.git-subview-tabs/)
  assert.match(styles, /\.git-subview-tab/)
  assert.match(styles, /\.git-history-list/)
  assert.match(styles, /\.git-history-commit-button/)
  assert.match(styles, /\.git-history-detail/)
  assert.match(styles, /\.git-history-back/)
  assert.match(styles, /\.git-subview-tab:focus-visible|\.git-history-commit-button:focus-visible|\.git-history-back:focus-visible/)
  assert.match(styles, /@media \(max-width: 32rem\)[\s\S]*\.git-history-/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.git-subview-tab/)
})
