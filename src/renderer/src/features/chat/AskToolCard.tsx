import {
  createContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'

import type {
  KernelAskAnswer,
  KernelAskQuestion,
  KernelAskToolState,
  KernelToolEntry
} from '../../../../shared/kernel-contract'
import { unknownErrorMessage } from '../../unknown-error-message'

export type AskToolInteraction = {
  sessionKey: string | null
  onSubmit: (
    sessionKey: string,
    toolCallId: string,
    answers: KernelAskAnswer[]
  ) => Promise<void>
  onCancel: (sessionKey: string, toolCallId: string) => Promise<void>
}

export const AskToolInteractionContext = createContext<AskToolInteraction | null>(null)

type QuestionDraft = {
  value: string | string[]
  customSelected: boolean
  customValue: string
}

type AnswerDraft = Record<string, QuestionDraft>

export function AskToolCard({
  ask,
  entry,
  interaction
}: {
  ask: KernelAskToolState
  entry: KernelToolEntry
  interaction: AskToolInteraction | null
}): React.JSX.Element {
  const formId = useId()
  const questionStageRef = useRef<HTMLDivElement>(null)
  const shouldFocusQuestionRef = useRef(false)
  const questions = ask.questions
  const [draft, setDraft] = useState<AnswerDraft>(() => initialDraft(questions))
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0)
  const [localPending, setLocalPending] = useState<'submit' | 'cancel' | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const answers = useMemo(() => buildAskAnswers(questions, draft), [draft, questions])
  const currentQuestion = questions[Math.min(activeQuestionIndex, questions.length - 1)]!
  const currentDraft = draft[currentQuestion.id] ?? emptyQuestionDraft(currentQuestion)
  const currentComplete = isQuestionComplete(currentQuestion, currentDraft)
  const lastQuestion = activeQuestionIndex === questions.length - 1
  const submitting = ask.status === 'submitting' || localPending !== null
  const canInteract = interaction?.sessionKey !== null && interaction?.sessionKey !== undefined

  useEffect(() => {
    if (!shouldFocusQuestionRef.current) return
    shouldFocusQuestionRef.current = false
    questionStageRef.current?.querySelector<HTMLElement>('input, textarea')?.focus()
  }, [activeQuestionIndex])

  const moveToQuestion = (nextIndex: number): void => {
    shouldFocusQuestionRef.current = true
    setActiveQuestionIndex(Math.max(0, Math.min(nextIndex, questions.length - 1)))
  }

  const updateCurrentDraft = (next: QuestionDraft): void => {
    setDraft((current) => ({ ...current, [currentQuestion.id]: next }))
    setLocalError(null)
  }

  const advance = (): void => {
    if (!currentComplete || lastQuestion) return
    moveToQuestion(activeQuestionIndex + 1)
  }

  const submit = async (): Promise<void> => {
    if (interaction === null || interaction.sessionKey === null || answers === null) return
    const sessionKey = interaction.sessionKey
    setLocalPending('submit')
    setLocalError(null)
    try {
      await interaction.onSubmit(sessionKey, entry.toolCallId, answers)
    } catch (error) {
      setLocalError(unknownErrorMessage(error))
    } finally {
      setLocalPending(null)
    }
  }

  const cancel = async (): Promise<void> => {
    if (interaction === null || interaction.sessionKey === null) return
    const sessionKey = interaction.sessionKey
    setLocalPending('cancel')
    setLocalError(null)
    try {
      await interaction.onCancel(sessionKey, entry.toolCallId)
    } catch (error) {
      setLocalError(unknownErrorMessage(error))
    } finally {
      setLocalPending(null)
    }
  }

  return (
    <article className="ask-tool-card" aria-labelledby={`${formId}-title`}>
      <header className="ask-tool-header">
        <div>
          <span className="ask-tool-kicker">Ask</span>
          <h3 id={`${formId}-title`}>需要你的回答</h3>
        </div>
        <span className="ask-tool-status" role="status" aria-live="polite">
          {ask.status === 'submitting'
            ? '正在提交'
            : `第 ${activeQuestionIndex + 1} / ${questions.length} 题`}
        </span>
      </header>

      <div
        className="ask-tool-progress"
        role="progressbar"
        aria-label="回答进度"
        aria-valuemin={1}
        aria-valuemax={questions.length}
        aria-valuenow={activeQuestionIndex + 1}
      >
        <span style={{ width: `${((activeQuestionIndex + 1) / questions.length) * 100}%` }} />
      </div>

      <form
        aria-busy={submitting}
        className="ask-tool-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!lastQuestion) {
            advance()
            return
          }
          void submit()
        }}
      >
        <div className="ask-tool-question-stage" ref={questionStageRef}>
          <AskQuestionField
            disabled={!canInteract || submitting}
            draft={currentDraft}
            formId={formId}
            question={currentQuestion}
            onChange={updateCurrentDraft}
            onSingleChoice={() => {
              if (!lastQuestion) moveToQuestion(activeQuestionIndex + 1)
            }}
          />
        </div>

        {ask.error !== null || localError !== null ? (
          <p className="ask-tool-error" role="alert">
            {localError ?? ask.error}
          </p>
        ) : null}

        <footer className="ask-tool-actions">
          <div className="ask-tool-secondary-actions">
            <button
              className="ask-tool-cancel"
              type="button"
              disabled={!canInteract || localPending !== null}
              onClick={() => void cancel()}
            >
              {localPending === 'cancel' ? '正在取消…' : '取消'}
            </button>
            {activeQuestionIndex > 0 ? (
              <button
                className="ask-tool-back"
                type="button"
                disabled={submitting}
                onClick={() => {
                  moveToQuestion(activeQuestionIndex - 1)
                  setLocalError(null)
                }}
              >
                上一题
              </button>
            ) : null}
          </div>
          <button
            className="ask-tool-submit"
            type="submit"
            disabled={!canInteract || submitting || !currentComplete || (lastQuestion && answers === null)}
          >
            {ask.status === 'submitting' || localPending === 'submit'
              ? '正在提交…'
              : lastQuestion
                ? '提交回答'
                : '下一题'}
          </button>
        </footer>
      </form>
    </article>
  )
}

function AskQuestionField({
  disabled,
  draft,
  formId,
  question,
  onChange,
  onSingleChoice
}: {
  disabled: boolean
  draft: QuestionDraft
  formId: string
  question: KernelAskQuestion
  onChange: (value: QuestionDraft) => void
  onSingleChoice: () => void
}): React.JSX.Element {
  const descriptionId = `${formId}-${question.id}-description`
  if (question.type === 'text') {
    return (
      <label className="ask-question ask-question-text">
        <span className="ask-question-title">{question.prompt}</span>
        <textarea
          aria-describedby={descriptionId}
          disabled={disabled}
          maxLength={4_000}
          placeholder={question.placeholder ?? '请输入回答'}
          rows={4}
          value={typeof draft.value === 'string' ? draft.value : ''}
          onChange={(event) => onChange({
            ...draft,
            value: event.currentTarget.value
          })}
        />
        <small id={descriptionId}>必填 · 最多 4000 个字符</small>
      </label>
    )
  }

  const selected = question.type === 'multiple' && Array.isArray(draft.value)
    ? new Set(draft.value)
    : null
  return (
    <fieldset aria-describedby={descriptionId} className="ask-question">
      <legend className="ask-question-title">{question.prompt}</legend>
      <div className="ask-option-list">
        {question.options.map((option, optionIndex) => {
          const optionDescriptionId = option.description === null
            ? undefined
            : `${formId}-${question.id}-${optionIndex}-description`
          const checked = question.type === 'multiple'
            ? selected?.has(option.value) === true
            : draft.value === option.value && !draft.customSelected
          return (
            <label className={`ask-option${checked ? ' selected' : ''}`} key={option.value}>
              <input
                aria-describedby={optionDescriptionId}
                checked={checked}
                disabled={disabled}
                name={`${formId}-${question.id}`}
                type={question.type === 'multiple' ? 'checkbox' : 'radio'}
                value={option.value}
                onChange={() => {
                  if (question.type === 'single') {
                    onChange({ ...draft, value: option.value, customSelected: false })
                    onSingleChoice()
                    return
                  }
                  const next = new Set(selected)
                  if (next.has(option.value)) next.delete(option.value)
                  else next.add(option.value)
                  onChange({
                    ...draft,
                    value: question.options
                      .filter((candidate) => next.has(candidate.value))
                      .map((candidate) => candidate.value)
                  })
                }}
              />
              <span className="ask-option-copy">
                <strong>{option.label}</strong>
                {option.description === null ? null : (
                  <small id={optionDescriptionId}>{option.description}</small>
                )}
              </span>
            </label>
          )
        })}
        <label className={`ask-option ask-option-custom${draft.customSelected ? ' selected' : ''}`}>
          <input
            checked={draft.customSelected}
            disabled={disabled}
            name={`${formId}-${question.id}`}
            type={question.type === 'multiple' ? 'checkbox' : 'radio'}
            onChange={() => {
              if (question.type === 'single') {
                onChange({ ...draft, value: '', customSelected: true })
                return
              }
              onChange({ ...draft, customSelected: !draft.customSelected })
            }}
          />
          <span className="ask-option-copy">
            <strong>其他</strong>
            <small>自行输入一个答案</small>
          </span>
        </label>
      </div>
      {draft.customSelected ? (
        <textarea
          autoFocus
          aria-label="其他答案"
          className="ask-custom-answer"
          disabled={disabled}
          maxLength={4_000}
          placeholder="请输入你的回答"
          rows={2}
          value={draft.customValue}
          onChange={(event) => onChange({ ...draft, customValue: event.currentTarget.value })}
        />
      ) : null}
      <small id={descriptionId}>
        {question.type === 'multiple' ? '必填 · 可多选' : '必填 · 请选择一项'}
      </small>
    </fieldset>
  )
}

function emptyQuestionDraft(question: KernelAskQuestion): QuestionDraft {
  return {
    value: question.type === 'multiple' ? [] : '',
    customSelected: false,
    customValue: ''
  }
}

function initialDraft(questions: readonly KernelAskQuestion[]): AnswerDraft {
  return Object.fromEntries(questions.map((question) => [
    question.id,
    emptyQuestionDraft(question)
  ]))
}

function isQuestionComplete(question: KernelAskQuestion, draft: QuestionDraft): boolean {
  if (question.type === 'text') {
    return typeof draft.value === 'string' && draft.value.trim().length > 0
  }
  if (question.type === 'single') {
    return draft.customSelected
      ? draft.customValue.trim().length > 0
      : typeof draft.value === 'string' && draft.value.length > 0
  }
  return (
    (Array.isArray(draft.value) && draft.value.length > 0) ||
    (draft.customSelected && draft.customValue.trim().length > 0)
  ) && (!draft.customSelected || draft.customValue.trim().length > 0)
}

export function buildAskAnswers(
  questions: readonly KernelAskQuestion[],
  draft: AnswerDraft
): KernelAskAnswer[] | null {
  const answers: KernelAskAnswer[] = []
  for (const question of questions) {
    const questionDraft = draft[question.id]
    if (questionDraft === undefined || !isQuestionComplete(question, questionDraft)) return null
    if (question.type === 'text') {
      if (typeof questionDraft.value !== 'string') return null
      answers.push({ questionId: question.id, value: questionDraft.value.trim() })
      continue
    }
    if (question.type === 'single') {
      if (questionDraft.customSelected) {
        answers.push({
          questionId: question.id,
          value: '',
          customValue: questionDraft.customValue.trim()
        })
        continue
      }
      if (typeof questionDraft.value !== 'string') return null
      answers.push({ questionId: question.id, value: questionDraft.value })
      continue
    }
    if (!Array.isArray(questionDraft.value)) return null
    answers.push({
      questionId: question.id,
      value: [...questionDraft.value],
      ...(questionDraft.customSelected
        ? { customValue: questionDraft.customValue.trim() }
        : {})
    })
  }
  return answers
}
