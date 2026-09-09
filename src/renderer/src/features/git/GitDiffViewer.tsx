import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { GitDiffFile, GitDiffResult } from '../../../../shared/git-contract'
import {
  buildGitDiffRenderRows,
  gitDiffRenderRowsMaxColumns,
  gitDiffRenderRowsText,
  gitErrorText,
  type GitDiffRenderRow
} from './git-changes-model'
import './git-changes.css'

export type GitDiffViewerResult = Pick<GitDiffResult, 'path' | 'state' | 'error'> & {
  files: GitDiffFile[]
}

export const GIT_DIFF_VIRTUALIZE_AFTER_ROWS = 300
export const GIT_DIFF_ROW_HEIGHT = 32
export const GIT_DIFF_OVERSCAN = 12

export function gitDiffStateText(result: GitDiffViewerResult): string {
  switch (result.state) {
    case 'binary': return '此文件是 binary 或非 UTF-8 内容，无法显示文本 diff。'
    case 'oversized': return '此 diff 超过安全显示上限。'
    case 'unsupported': return '当前 diff 形状不受支持。'
    case 'conflict': return '冲突文件不提供 diff。'
    case 'trust-required': return 'Repository 授权已经失效，请刷新并重新允许。'
    case 'not-repository': return '当前 Project 不再属于 Git repository。'
    case 'error': return result.error === null ? '无法读取 diff。' : gitErrorText(result.error)
    case 'ready': return ''
  }
}

export function GitDiffViewer({ result }: { result: GitDiffViewerResult }): React.JSX.Element {
  if (result.state !== 'ready') {
    return <p className={`git-diff-state ${result.state}`}>{gitDiffStateText(result)}</p>
  }
  if (result.files.length === 0) {
    return <p className="git-diff-state">此快照没有可显示的 diff。</p>
  }
  return <GitReadyDiffView result={result} />
}

function GitReadyDiffView({ result }: { result: GitDiffViewerResult }): React.JSX.Element {
  const rows = useMemo(() => buildGitDiffRenderRows(result.files), [result.files])
  if (rows.length > GIT_DIFF_VIRTUALIZE_AFTER_ROWS) {
    return <VirtualGitDiffRows path={result.path} rows={rows} />
  }
  return (
    <div
      className="git-diff-scroll"
      data-virtualized="false"
      tabIndex={0}
      aria-label={`${result.path} diff`}
    >
      <div className="git-diff-file">
        {rows.map((row) => <GitDiffRow key={row.id} row={row} />)}
      </div>
    </div>
  )
}

function VirtualGitDiffRows({
  path,
  rows
}: {
  path: string
  rows: readonly GitDiffRenderRow[]
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [textMode, setTextMode] = useState(false)
  const [copyNotice, setCopyNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const fullText = useMemo(() => gitDiffRenderRowsText(rows), [rows])
  const maximumColumns = useMemo(() => gitDiffRenderRowsMaxColumns(rows), [rows])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GIT_DIFF_ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: GIT_DIFF_OVERSCAN
  })

  useEffect(() => setCopyNotice(null), [fullText])

  const copyFullDiff = async (): Promise<void> => {
    try {
      if (navigator.clipboard === undefined) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(fullText)
      setCopyNotice({ tone: 'info', text: '完整 diff 已复制。' })
    } catch {
      setCopyNotice({ tone: 'error', text: '无法复制完整 diff，请切换到完整文本后手动复制。' })
    }
  }

  return (
    <div className="git-diff-large-view">
      <div className="git-diff-large-toolbar">
        <span>大型 diff · {rows.length} 行</span>
        <div className="git-diff-large-actions">
          <button
            type="button"
            aria-pressed={textMode}
            onClick={() => {
              setCopyNotice(null)
              setTextMode((current) => !current)
            }}
          >
            {textMode ? '返回虚拟视图' : '查看完整文本'}
          </button>
          <button type="button" onClick={() => void copyFullDiff()}>复制全部</button>
        </div>
      </div>
      {textMode ? (
        <textarea
          className="git-diff-full-text"
          aria-label={`${path} 完整 diff 文本`}
          readOnly
          spellCheck={false}
          wrap="off"
          value={fullText}
        />
      ) : (
        <div
          ref={scrollRef}
          className="git-diff-scroll virtualized"
          data-virtualized="true"
          style={{ height: `${Math.min(rows.length * GIT_DIFF_ROW_HEIGHT, 430)}px` }}
          tabIndex={0}
          aria-label={`${path} diff，共 ${rows.length} 行；可切换到完整文本连续阅读`}
        >
          <div
            className="git-diff-virtual-space"
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: `max(100%, calc(${maximumColumns}ch + 8.5em))`
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]
              if (row === undefined) return null
              return (
                <div
                  className="git-diff-virtual-row"
                  key={virtualRow.key}
                  style={{
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  <GitDiffRow row={row} />
                </div>
              )
            })}
          </div>
        </div>
      )}
      {copyNotice === null ? null : (
        <p className={`git-diff-copy-notice ${copyNotice.tone}`} role={copyNotice.tone === 'error' ? 'alert' : 'status'}>
          {copyNotice.text}
        </p>
      )}
    </div>
  )
}

function GitDiffRow({ row }: { row: GitDiffRenderRow }): React.JSX.Element {
  if (row.kind === 'fold') {
    return (
      <div className="git-diff-fold" aria-label={`${row.unmodifiedLines} 行未修改内容已折叠`}>
        <span className="git-diff-fold-rail" aria-hidden="true" />
        <span>{row.unmodifiedLines} unmodified lines</span>
      </div>
    )
  }
  const line = row.line
  return (
    <div className={`git-diff-line ${line.kind}`}>
      <span className="git-diff-line-number">{line.oldLine ?? ''}</span>
      <span className="git-diff-line-number">{line.newLine ?? ''}</span>
      <span className="git-diff-line-marker">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>
      <span className="git-diff-line-content">{line.content}</span>
    </div>
  )
}
