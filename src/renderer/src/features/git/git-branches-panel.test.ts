import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import {
  createEmptyGitBranchesDraft,
  type GitBranchesDraftViewModel
} from './git-branches-model.ts'

const vite = await createServer({
  configFile: false,
  root: new URL('../../../../../', import.meta.url).pathname,
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false }
})
after(() => vite.close())

const panelModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/git/GitBranchesPanel.tsx'
) as typeof import('./GitBranchesPanel.tsx')
const dialogModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/git/GitBranchSyncDialog.tsx'
) as typeof import('./GitBranchSyncDialog.tsx')
const panelSource = await readFile(new URL('./GitBranchesPanel.tsx', import.meta.url), 'utf8')
const dialogSource = await readFile(new URL('./GitBranchSyncDialog.tsx', import.meta.url), 'utf8')
const modelSource = await readFile(new URL('./git-branches-model.ts', import.meta.url), 'utf8')
const styles = await readFile(new URL('./git-changes.css', import.meta.url), 'utf8')

function readyView(view: Partial<GitBranchesDraftViewModel> = {}): GitBranchesDraftViewModel {
  return {
    ...createEmptyGitBranchesDraft(),
    listStatus: 'ready',
    headKind: 'named',
    currentBranchLabel: 'main',
    upstreamText: 'origin/main',
    ahead: 1,
    behind: 0,
    localBranches: [
      {
        branchId: 'local-main',
        name: 'main',
        isCurrent: true,
        upstreamText: 'origin/main'
      },
      {
        branchId: 'local-feature',
        name: 'feature/long-branch-name',
        isCurrent: false,
        upstreamText: null
      }
    ],
    remoteGroups: [
      {
        remoteId: 'remote-origin',
        name: 'origin',
        branches: [
          { branchId: 'rt-origin-main', name: 'origin/main' },
          { branchId: 'rt-origin-dev', name: 'origin/dev' }
        ],
        truncated: false
      }
    ],
    remotes: [{ remoteId: 'remote-origin', name: 'origin' }],
    actions: {
      create: { enabled: true, reason: null },
      switch: { enabled: true, reason: null },
      fetch: { enabled: true, reason: null },
      pull: { enabled: true, reason: null },
      push: { enabled: true, reason: null }
    },
    selectedLocalBranchId: 'local-feature',
    selectedRemoteId: 'remote-origin',
    ...view
  }
}

const noop = (): void => {}

test('pure Branches panel renders summary, local marker, remote groups and five actions', () => {
  const html = renderToStaticMarkup(createElement(panelModule.GitBranchesPanel, {
    view: readyView({ localTruncated: true, trackingTruncated: true }),
    onSelectLocalBranch: noop,
    onOpenCreate: noop,
    onOpenSwitch: noop,
    onOpenFetch: noop,
    onOpenPull: noop,
    onOpenPush: noop,
    onDialogCancel: noop,
    onDialogConfirm: noop
  }))

  assert.match(html, /分支与同步/)
  assert.match(html, /当前分支/)
  assert.match(html, /origin\/main · 领先 1 · 落后 0/)
  assert.match(html, /本地分支/)
  assert.match(html, /feature\/long-branch-name/)
  assert.match(html, /当前/)
  assert.match(html, /无 upstream/)
  assert.match(html, /本地分支列表已达到安全上限/)
  assert.match(html, /Remote-tracking/)
  assert.match(html, /origin\/dev/)
  assert.match(html, /Create/)
  assert.match(html, /Switch/)
  assert.match(html, /Fetch/)
  assert.match(html, /Pull/)
  assert.match(html, /Push/)
  assert.match(html, /aria-current="true"/)
  assert.match(html, /aria-pressed="true"/)
})

test('Branches panel surfaces loading/error states without mutation controls', () => {
  const loading = renderToStaticMarkup(createElement(panelModule.GitBranchesPanel, {
    view: createEmptyGitBranchesDraft(),
    onSelectLocalBranch: noop,
    onOpenCreate: noop,
    onOpenSwitch: noop,
    onOpenFetch: noop,
    onOpenPull: noop,
    onOpenPush: noop,
    onDialogCancel: noop,
    onDialogConfirm: noop
  }))
  assert.match(loading, /正在读取分支与同步状态/)
  assert.match(loading, /role="status"/)

  const error = renderToStaticMarkup(createElement(panelModule.GitBranchesPanel, {
    view: {
      ...createEmptyGitBranchesDraft(),
      listStatus: 'error',
      listError: 'prepare failed'
    },
    onSelectLocalBranch: noop,
    onOpenCreate: noop,
    onOpenSwitch: noop,
    onOpenFetch: noop,
    onOpenPull: noop,
    onOpenPush: noop,
    onDialogCancel: noop,
    onDialogConfirm: noop
  }))
  assert.match(error, /prepare failed/)
  assert.match(error, /role="alert"/)
  assert.doesNotMatch(error, /Create|Switch|Fetch|Pull|Push/)
})

test('disabled Branches actions expose visible reasons through aria-describedby', () => {
  const html = renderToStaticMarkup(createElement(panelModule.GitBranchesPanel, {
    view: readyView({
      actions: {
        create: { enabled: true, reason: null },
        switch: { enabled: false, reason: '需要 clean index 与 worktree。' },
        fetch: { enabled: true, reason: null },
        pull: { enabled: false, reason: '需要 clean index 与 worktree。' },
        push: { enabled: true, reason: null }
      }
    }),
    onSelectLocalBranch: noop,
    onOpenCreate: noop,
    onOpenSwitch: noop,
    onOpenFetch: noop,
    onOpenPull: noop,
    onOpenPush: noop,
    onDialogCancel: noop,
    onDialogConfirm: noop
  }))
  assert.match(html, /aria-label="不可用动作说明"/)
  assert.match(html, /aria-describedby="[^"]+-switch-reason"/)
  assert.match(html, /aria-describedby="[^"]+-pull-reason"/)
  assert.match(html, /需要 clean index 与 worktree。/)
})

test('GitBranchSyncDialog source reuses useModalDialog and keeps independent step rows', () => {
  assert.match(dialogSource, /useModalDialog\(\{/)
  assert.match(dialogSource, /dismissDisabled: busy/)
  assert.match(dialogSource, /role="dialog"/)
  assert.match(dialogSource, /aria-modal="true"/)
  assert.match(dialogSource, /aria-busy=\{busy\}/)
  assert.match(dialogSource, /aria-live="polite"/)
  assert.match(dialogSource, /gitBranchSyncStepLabel/)
  assert.match(dialogSource, /kind="branch"/)
  assert.match(dialogSource, /kind="fetch"/)
  assert.match(dialogSource, /kind="fast-forward"/)
  assert.match(dialogSource, /kind="push"/)
  assert.match(dialogSource, /kind="post-view"/)
  assert.match(dialogSource, /gitBranchSyncShouldShowPostView/)
  assert.match(dialogSource, /gitBranchSyncActionDisabled/)
  assert.match(dialogSource, /gitBranchSyncBuildConfirmPayload/)
  assert.match(dialogSource, /Select/)
  assert.doesNotMatch(dialogSource, /window\.piGit/)
  assert.doesNotMatch(dialogSource, /from ['\"].*git-contract/)
  assert.doesNotMatch(dialogSource, /prepareBranch|executeBranch|prepare branch-sync|execute branch-sync/)
  assert.doesNotMatch(dialogSource, /document\.addEventListener\('keydown'/)

  // Module load proves pure SSR export shape.
  assert.equal(typeof dialogModule.GitBranchSyncDialog, 'function')
})

test('Branches panel and model stay pure with Parent-wirable props only', () => {
  assert.match(panelSource, /export type GitBranchesPanelProps/)
  assert.match(panelSource, /onOpenCreate/)
  assert.match(panelSource, /onOpenSwitch/)
  assert.match(panelSource, /onOpenFetch/)
  assert.match(panelSource, /onOpenPull/)
  assert.match(panelSource, /onOpenPush/)
  assert.match(panelSource, /onDialogConfirm/)
  assert.match(panelSource, /GitBranchSyncDialog/)
  assert.doesNotMatch(panelSource, /window\.piGit/)
  assert.doesNotMatch(panelSource, /from ['\"].*git-contract/)
  assert.doesNotMatch(panelSource, /stageFile|unstageFile|prepareCommit|executeCommit/)
  assert.doesNotMatch(modelSource, /window\.piGit/)
  assert.doesNotMatch(modelSource, /from ['\"].*git-contract/)
  assert.match(modelSource, /export type GitBranchSyncConfirmPayload/)
  assert.match(modelSource, /export type GitBranchSyncDialogResult/)
  assert.match(panelSource, /branch\.isCurrent \? \(/)
  assert.match(panelSource, /className="git-branches-item-button current"/)
})

test('Branches CSS covers narrow bottom-sheet, touch targets, truncation and reduced-motion', () => {
  assert.match(styles, /\.git-branches-panel/)
  assert.match(styles, /\.git-branches-summary/)
  assert.match(styles, /\.git-branches-actions/)
  assert.match(styles, /\.git-branches-action-reasons/)
  assert.match(styles, /\.git-branches-list/)
  assert.match(styles, /\.git-branches-item-button/)
  assert.match(styles, /\.git-branch-sync-dialog-backdrop/)
  assert.match(styles, /\.git-branch-sync-dialog\b/)
  assert.match(styles, /width: min\(28rem, 100%\)/)
  assert.match(styles, /text-overflow: ellipsis/)
  assert.match(styles, /\.git-branches-item-button:focus-visible|\.git-branches-action:focus-visible/)
  assert.match(styles, /@media \(max-width: 32rem\)[\s\S]*\.git-branches-action[\s\S]*min-height: 44px/)
  assert.match(styles, /@media \(max-width: 32rem\)[\s\S]*\.git-branch-sync-dialog-backdrop[\s\S]*place-items: end center/)
  assert.match(styles, /@media \(max-width: 32rem\)[\s\S]*\.git-branch-sync-dialog[\s\S]*width: 100%/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.git-branches-action/)
  assert.match(styles, /\.git-branch-sync-dialog-result-row\.error/)
  assert.match(styles, /\.git-branch-sync-dialog-result-row\.success/)
  assert.match(styles, /\.git-branch-sync-dialog-result-row\.warning/)
})
