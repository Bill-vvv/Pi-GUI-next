import type { CSSProperties, RefObject } from 'react'
import { createPortal } from 'react-dom'

import type {
  KernelCommandDescriptor,
  KernelProjectPathMatch
} from '../../../../shared/kernel-contract'

type SlashCommandSurfaceProps = {
  commands: KernelCommandDescriptor[]
  activeCommandId: string | null
  surfaceRef: RefObject<HTMLElement | null>
  selectedOptionRef: RefObject<HTMLButtonElement | null>
  onSelect: (command: KernelCommandDescriptor) => void
}

export function SlashCommandSurface({
  commands,
  activeCommandId,
  surfaceRef,
  selectedOptionRef,
  onSelect
}: SlashCommandSurfaceProps): React.JSX.Element {
  return (
    <section ref={surfaceRef} className="slash-command-surface" aria-label="Slash 命令">
      <div id="slash-command-listbox" className="slash-command-list" role="listbox">
        {commands.length > 0 ? (
          commands.map((command) => (
            <button
              ref={command.id === activeCommandId ? selectedOptionRef : undefined}
              id={`slash-command-${command.id}`}
              className={`slash-command-option${command.id === activeCommandId ? ' selected' : ''}`}
              type="button"
              role="option"
              aria-selected={command.id === activeCommandId}
              key={command.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(command)}
            >
              <span className="slash-command-name">
                /{command.name}
                {command.argumentHint !== null ? (
                  <span className="slash-command-argument-hint"> {command.argumentHint}</span>
                ) : null}
              </span>
              <span className="slash-command-description">{command.description}</span>
              <span className="slash-command-source">{commandSourceLabel(command.source)}</span>
            </button>
          ))
        ) : (
          <p id="slash-command-empty-state" role="status">没有匹配的命令</p>
        )}
      </div>
    </section>
  )
}

type ProjectPathSearch = {
  status: 'loading' | 'ready' | 'error'
}

type ProjectPathSurfaceProps = {
  search: ProjectPathSearch | null
  matches: KernelProjectPathMatch[]
  activeOptionKey: string | null
  placement: 'above' | 'below' | 'left' | 'right'
  style: CSSProperties
  surfaceRef: RefObject<HTMLDivElement | null>
  selectedOptionRef: RefObject<HTMLButtonElement | null>
  onSelect: (match: KernelProjectPathMatch) => void
}

export function ProjectPathSurface({
  search,
  matches,
  activeOptionKey,
  placement,
  style,
  surfaceRef,
  selectedOptionRef,
  onSelect
}: ProjectPathSurfaceProps): React.JSX.Element {
  return createPortal(
    <div
      ref={surfaceRef}
      className="project-path-surface"
      data-placement={placement}
      style={style}
    >
      <div
        id="project-path-listbox"
        className="project-path-list"
        role="listbox"
        aria-label="项目路径"
      >
        {search === null || search.status === 'loading' ? (
          <p className="project-path-state" role="status" aria-live="polite">
            正在搜索项目路径…
          </p>
        ) : search.status === 'error' ? (
          <p className="project-path-state error" role="alert">
            项目路径搜索失败，请重试。
          </p>
        ) : matches.length === 0 ? (
          <p className="project-path-state" role="status">没有匹配的项目路径</p>
        ) : (
          matches.map((match, index) => {
            const matchKey = projectPathMatchKey(match)
            const selected = matchKey === activeOptionKey
            return (
              <button
                ref={selected ? selectedOptionRef : undefined}
                id={`project-path-option-${index}`}
                className={`project-path-option${selected ? ' selected' : ''}`}
                type="button"
                role="option"
                aria-selected={selected}
                key={`${matchKey}:${index}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(match)}
              >
                <span className="project-path-kind">
                  {match.kind === 'directory' ? '目录' : '文件'}
                </span>
                <span className="project-path-value">{match.path}</span>
              </button>
            )
          })
        )}
      </div>
    </div>,
    document.body
  )
}

function commandSourceLabel(source: KernelCommandDescriptor['source']): string {
  return {
    gui: 'GUI',
    'pi-rpc': 'Pi RPC',
    extension: 'Extension',
    prompt: 'Prompt',
    skill: 'Skill'
  }[source]
}

export function projectPathMatchKey(match: KernelProjectPathMatch): string {
  return `${match.kind}:${match.path}`
}
