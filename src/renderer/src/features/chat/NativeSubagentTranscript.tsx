import { useEffect, useRef, useState } from 'react'

import type { KernelSubagentStatus, KernelSubagentTranscript } from '../../../../shared/kernel-contract'
import { unknownErrorMessage } from '../../unknown-error-message'
import { CompletedTurn, groupConversationTurns, LiveTurn } from './TimelineTurns'
import { subagentParticipantStatusLabel } from './subagent-task-detail-model'

export function NativeSubagentTranscript({
  taskId,
  expectedSessionKey,
  initialStatus,
  onGetTranscript,
  onControl
}: {
  taskId: string
  expectedSessionKey: string
  initialStatus: KernelSubagentStatus
  onGetTranscript: (taskId: string, sessionKey: string) => Promise<KernelSubagentTranscript>
  onControl?: (taskId: string, sessionKey: string, action: 'stop' | 'continue', message?: string) => Promise<void>
}): React.JSX.Element {
  const [transcript, setTranscript] = useState<KernelSubagentTranscript | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [message, setMessage] = useState('')
  const [controlling, setControlling] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const generation = useRef(0)
  const controlOwner = useRef(0)
  const controlPending = useRef(false)
  const reader = useRef(onGetTranscript)
  reader.current = onGetTranscript
  const status = transcript?.status ?? initialStatus
  const active = status === 'pending' || status === 'running' || status === 'detached'
  const turns = groupConversationTurns(transcript?.entries ?? [])
  const thinkingElapsed = useRef(new Map<string, number>())

  useEffect(() => {
    controlOwner.current += 1
    setTranscript(null)
    setMessage('')
    setControlling(false)
    controlPending.current = false
    return () => { controlOwner.current += 1 }
  }, [taskId, expectedSessionKey])

  useEffect(() => {
    const requestGeneration = ++generation.current
    let timer: ReturnType<typeof setTimeout> | null = null
    let reading = false
    let polling = true
    setLoading(true)
    setError(null)
    setUnavailable(false)
    async function read(): Promise<void> {
      if (reading || generation.current !== requestGeneration) return
      reading = true
      timer = null
      try {
        const result = await reader.current(taskId, expectedSessionKey)
        if (generation.current !== requestGeneration) return
        if (result.taskId !== taskId) throw new Error('子任务身份与请求不一致。')
        setTranscript(result)
        setLoading(false)
        polling = result.status === 'pending' || result.status === 'running' || result.status === 'detached'
        if (polling && !document.hidden) {
          timer = setTimeout(() => void read(), 2000)
        }
      } catch (readError) {
        if (generation.current !== requestGeneration) return
        setError(unknownErrorMessage(readError))
        setLoading(false)
        setUnavailable(true)
        polling = false
      } finally {
        reading = false
      }
    }
    function visibilityChanged(): void {
      if (document.hidden) {
        if (timer !== null) clearTimeout(timer)
        timer = null
      } else if (polling) {
        void read()
      }
    }
    document.addEventListener('visibilitychange', visibilityChanged)
    void read()
    return () => {
      generation.current += 1
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [taskId, expectedSessionKey, initialStatus, refresh])

  async function control(action: 'stop' | 'continue'): Promise<void> {
    if (onControl === undefined || controlPending.current || unavailable) return
    const text = message.trim()
    if (action === 'continue' && text.length === 0) return
    const requestOwner = controlOwner.current
    controlPending.current = true
    setControlling(true)
    setError(null)
    try {
      await onControl(taskId, expectedSessionKey, action, action === 'continue' ? text : undefined)
      if (controlOwner.current !== requestOwner) return
      if (action === 'continue') setMessage('')
      setRefresh((value) => value + 1)
    } catch (controlError) {
      if (controlOwner.current !== requestOwner) return
      setError(unknownErrorMessage(controlError))
    } finally {
      if (controlOwner.current === requestOwner) {
        controlPending.current = false
        setControlling(false)
      }
    }
  }

  return (
    <section className="subagent-task-transcript" aria-label="子任务对话">
      <div className="subagent-task-transcript-heading">
        <h3>子任务对话</h3>
        <span role="status">{subagentParticipantStatusLabel(status)}</span>
        <button type="button" disabled={loading || controlling} onClick={() => setRefresh((value) => value + 1)}>刷新</button>
        {active && onControl !== undefined ? (
          <button type="button" disabled={controlling || loading || unavailable} onClick={() => void control('stop')}>{controlling ? '处理中…' : '停止'}</button>
        ) : null}
      </div>
      {error === null ? null : <p className="subagent-task-detail-error" role="alert">{error}</p>}
      {unavailable ? <p className="subagent-task-detail-empty" role="status">当前无法读取或控制此子任务，可刷新重试。历史任务可能已没有可用的执行实例。</p> : null}
      {loading && transcript === null ? <p className="subagent-task-detail-empty" role="status">正在读取子任务对话…</p> : null}
      {turns.map((turn, index) => active && index === turns.length - 1 ? (
        <LiveTurn key={turn.id} turn={turn} toolDisplayDensity="standard" thinkingElapsedByEntryId={thinkingElapsed.current} />
      ) : (
        <CompletedTurn key={turn.id} turn={turn} toolDisplayDensity="standard" runElapsedMs={null} thinkingElapsedByEntryId={thinkingElapsed.current} />
      ))}
      {!loading && error === null && turns.length === 0 ? <p className="subagent-task-detail-empty">子任务尚无对话内容。</p> : null}
      {!active && transcript !== null && onControl !== undefined ? (
        <form className="subagent-task-continue" onSubmit={(event) => { event.preventDefault(); void control('continue') }}>
          <label htmlFor="subagent-task-continue-message">继续这个子任务</label>
          <textarea id="subagent-task-continue-message" rows={3} value={message} disabled={controlling} onChange={(event) => setMessage(event.target.value)} />
          <button type="submit" disabled={controlling || loading || unavailable || message.trim().length === 0}>{controlling ? '处理中…' : '发送并继续'}</button>
        </form>
      ) : null}
    </section>
  )
}
