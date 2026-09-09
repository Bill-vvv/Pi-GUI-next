import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
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
  '/src/renderer/src/features/git/GitCommitDialog.tsx'
) as typeof import('./GitCommitDialog.tsx')
const source = await readFile(new URL('./GitCommitDialog.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('./git-changes.css', import.meta.url), 'utf8')

test('pure UI helpers gate empty messages, missing upstream, amend and landed commits', () => {
  assert.equal(module.isGitCommitMessageSubmittable('  '), false)
  assert.equal(module.isGitCommitMessageSubmittable('\n\t'), false)
  assert.equal(module.isGitCommitMessageSubmittable('fix'), true)

  assert.equal(module.gitCommitPushTargetLabel(null), '不可用（无上游）')
  assert.equal(
    module.gitCommitPushTargetLabel({ remote: 'origin', branch: 'main' }),
    'origin/main'
  )

  assert.equal(module.gitCommitActionDisabled('commit', {
    busy: false,
    canAmend: false,
    commitSucceeded: false,
    hasUpstream: false,
    message: 'ready'
  }), false)
  assert.equal(module.gitCommitActionDisabled('commit-and-push', {
    busy: false,
    canAmend: true,
    commitSucceeded: false,
    hasUpstream: false,
    message: 'ready'
  }), true)
  assert.equal(module.gitCommitActionDisabled('amend', {
    busy: false,
    canAmend: false,
    commitSucceeded: false,
    hasUpstream: true,
    message: 'ready'
  }), true)
  assert.equal(module.gitCommitActionDisabled('commit', {
    busy: true,
    canAmend: true,
    commitSucceeded: false,
    hasUpstream: true,
    message: 'ready'
  }), true)
  assert.equal(module.gitCommitActionDisabled('commit-and-push', {
    busy: false,
    canAmend: true,
    commitSucceeded: false,
    hasUpstream: true,
    message: '  '
  }), true)
  for (const mode of ['commit', 'commit-and-push', 'amend'] as const) {
    assert.equal(module.gitCommitActionDisabled(mode, {
      busy: false,
      canAmend: true,
      commitSucceeded: true,
      hasUpstream: true,
      message: 'already landed'
    }), true)
  }
})

test('result presentation keeps commit, push and refresh outcomes independent', () => {
  assert.equal(module.gitCommitResultLabel('commit', 'succeeded'), '提交成功')
  assert.equal(module.gitCommitResultLabel('commit', 'failed'), '提交失败')
  assert.equal(module.gitCommitResultLabel('push', 'succeeded'), '推送成功')
  assert.equal(module.gitCommitResultLabel('push', 'failed'), '推送失败')
  assert.equal(module.gitCommitResultLabel('push', 'skipped'), '已跳过推送')
  assert.equal(module.gitCommitResultLabel('refresh', 'warning'), '刷新警告')
  assert.equal(module.gitCommitResultLabel('refresh', 'failed'), '刷新失败')

  assert.equal(module.gitCommitResultTone('succeeded'), 'success')
  assert.equal(module.gitCommitResultTone('failed'), 'error')
  assert.equal(module.gitCommitResultTone('skipped'), 'muted')
  assert.equal(module.gitCommitResultTone('warning'), 'warning')

  // Partial success must not collapse into a single failure tone for commit.
  assert.notEqual(
    module.gitCommitResultTone('succeeded'),
    module.gitCommitResultTone('failed')
  )
})

test('GitCommitDialog is a pure UI modal with Parent-wirable props and no backend types', () => {
  assert.match(source, /export type GitCommitMode = 'commit' \| 'commit-and-push' \| 'amend'/)
  assert.match(source, /export type GitCommitDialogPreview = \{/)
  assert.match(source, /stagedFileCount: number/)
  assert.match(source, /branch: string/)
  assert.match(source, /upstream: GitCommitDialogUpstream \| null/)
  assert.match(source, /suggestedMessage: string/)
  assert.match(source, /canAmend: boolean/)
  assert.match(source, /busy: boolean/)
  assert.match(source, /result\?: GitCommitDialogResult \| null/)
  assert.match(source, /onCancel: \(\) => void/)
  assert.match(source, /onSubmit: \(mode: GitCommitMode, message: string\) => void/)
  assert.doesNotMatch(source, /from ['\"].*git-contract|window\.piGit|GitCommitSnapshot|prepareCommit|executeCommit/)
  assert.doesNotMatch(source, /git add -A|git commit -a|--no-verify|force push|model generate|AI/)
})

test('modal reuses useModalDialog, ARIA contract, backdrop dismiss and busy gates', () => {
  assert.match(source, /useModalDialog\(\{/)
  assert.match(source, /dismissDisabled: busy/)
  assert.match(source, /initialFocus: \(\) => messageRef\.current \?\? cancelRef\.current/)
  assert.match(source, /role="dialog"/)
  assert.match(source, /aria-modal="true"/)
  assert.match(source, /aria-labelledby=\{titleId\}/)
  assert.match(source, /aria-describedby=\{describedBy\}/)
  assert.match(source, /aria-busy=\{busy\}/)
  assert.match(source, /tabIndex=\{-1\}/)
  assert.match(source, /event\.target !== event\.currentTarget/)
  assert.match(source, /if \(busy \|\| event\.target !== event\.currentTarget\) return/)
  assert.match(source, /onCancel\(\)/)
  assert.match(source, /disabled=\{busy \|\| commitSucceeded\}/)
  assert.match(source, /commitSucceeded: boolean/)
  assert.match(source, /result\?\.commit\.status === 'succeeded'/)
  assert.match(source, /gitCommitActionDisabled\('commit'/)
  assert.match(source, /gitCommitActionDisabled\('commit-and-push'/)
  assert.match(source, /gitCommitActionDisabled\('amend'/)
  assert.match(source, /onSubmit\(mode, message\)/)
  assert.doesNotMatch(source, /document\.addEventListener\('keydown'/)
})

test('result UI renders commit/push independently and only elevates refresh warnings', () => {
  assert.match(source, /kind="commit"[\s\S]*?status=\{result\.commit\.status\}/)
  assert.match(source, /kind="push"[\s\S]*?status=\{result\.push\.status\}/)
  assert.match(source, /result\.refresh == null \|\| result\.refresh\.status === 'ok'/)
  assert.doesNotMatch(source, /role=\{tone === 'error' \? 'alert' : undefined\}/)
  assert.match(source, /aria-live="polite"/)
  assert.match(source, /不可用（没有可修改的现有提交）/)
  assert.doesNotMatch(source, /操作失败|全部失败|partial failure collapsed/)
  assert.match(source, /current === previousSuggestionRef\.current/)
  assert.match(source, /previousSuggestionRef\.current = preview\.suggestedMessage/)
})

test('compact commit dialog styles cover narrow, touch and reduced-motion paths', () => {
  assert.match(styles, /\.git-commit-dialog-backdrop/)
  assert.match(styles, /\.git-commit-dialog\b/)
  assert.match(styles, /width: min\(28rem, 100%\)/)
  assert.match(styles, /@media \(max-width: 32rem\)/)
  assert.match(styles, /min-height: 44px/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.git-commit-dialog-footer button/)
  assert.match(styles, /\.git-commit-dialog-result-row\.error/)
  assert.match(styles, /\.git-commit-dialog-result-row\.success/)
  assert.match(styles, /\.git-commit-dialog-result-row\.warning/)
})
