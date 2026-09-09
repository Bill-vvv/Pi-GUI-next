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
import { Icon } from '../../components/Icon'
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
  const stepPanelRef = useRef<HTMLDivElement>(null)
  const shouldFocusStepRef = useRef(false)
  const questions = ask.questions
  const [draft, setDraft] = useState<AnswerDraft>(() => initialDraft(questions))
  const [activeStep, setActiveStep] = useState(0)
  const [localPending, setLocalPending] = useState<'submit' | 'cancel' | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const answers = useMemo(() => buildAskAnswers(questions, draft), [draft, questions])
  const completedQuestions = useMemo(() => questions.map((question) => {
    const questionDraft = draft[question.id] ?? emptyQuestionDraft(question)
    return isQuestionComplete(question, questionDraft)
  }), [draft, questions])
  const answeredCount = completedQuestions.filter(Boolean).length
  const reviewing = activeStep === questions.length
  const currentQuestion = reviewing ? null : questions[activeStep]!
  const currentDraft = currentQuestion === null
    ? null
    : draft[currentQuestion.id] ?? emptyQuestionDraft(currentQuestion)
  const currentComplete = currentQuestion !== null && currentDraft !== null
    ? isQuestionComplete(currentQuestion, currentDraft)
    : false
  const lastQuestion = activeStep === questions.length - 1
  const submitting = ask.status === 'submitting' || localPending !== null
  const canInteract = interaction?.sessionKey !== null && interaction?.sessionKey !== undefined

  useEffect(() => {
    if (!shouldFocusStepRef.current) return
    shouldFocusStepRef.current = false
    const panel = stepPanelRef.current
    const target = panel?.querySelector<HTMLElement>(
      'input:not(:disabled), textarea:not(:disabled), button:not(:disabled)'
    )
    if (target !== null && target !== undefined) target.focus()
    else panel?.focus()
  }, [activeStep])

  const moveToStep = (nextStep: number): void => {
    shouldFocusStepRef.current = true
    setActiveStep(Math.max(0, Math.min(nextStep, questions.length)))
    setLocalError(null)
  }

  const updateCurrentDraft = (next: QuestionDraft): void => {
    if (currentQuestion === null) return
    setDraft((current) => ({ ...current, [currentQuestion.id]: next }))
    setLocalError(null)
  }

  const advance = (): void => {
    if (!currentComplete || reviewing) return
    moveToStep(activeStep + 1)
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
            : reviewing
              ? `已回答 ${answeredCount} / ${questions.length}`
              : `第 ${activeStep + 1} / ${questions.length} 题 · 已回答 ${answeredCount}`}
        </span>
      </header>

      <nav className="ask-step-navigation" aria-label="问卷步骤">
        <ol className="ask-step-list">
          {questions.map((question, questionIndex) => {
            const complete = completedQuestions[questionIndex] === true
            const current = activeStep === questionIndex
            return (
              <li className="ask-step-item" key={question.id}>
                <button
                  aria-current={current ? 'step' : undefined}
                  aria-label={`第 ${questionIndex + 1} 题，${complete ? '已回答' : '未回答'}：${question.prompt}`}
                  className={`ask-step-button${current ? ' current' : ''}${complete ? ' complete' : ''}`}
                  data-tooltip={question.prompt}
                  disabled={submitting}
                  type="button"
                  onClick={() => moveToStep(questionIndex)}
                >
                  <span className="ask-step-number">{questionIndex + 1}</span>
                  {complete ? <Icon name="check" size="sm" /> : null}
                </button>
              </li>
            )
          })}
          <li className="ask-step-item ask-step-review-item">
            <button
              aria-current={reviewing ? 'step' : undefined}
              aria-label={`确认回答，已完成 ${answeredCount} / ${questions.length} 题`}
              className={`ask-step-button ask-step-review${reviewing ? ' current' : ''}`}
              disabled={submitting}
              type="button"
              onClick={() => moveToStep(questions.length)}
            >
              确认
            </button>
          </li>
        </ol>
      </nav>

      <form
        aria-busy={submitting}
        className="ask-tool-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!reviewing) {
            advance()
            return
          }
          void submit()
        }}
      >
        <div
          className="ask-tool-question-stage"
          ref={stepPanelRef}
          tabIndex={-1}
        >
          {reviewing ? (
            <AskReviewStep
              draft={draft}
              formId={formId}
              questions={questions}
              onEdit={moveToStep}
            />
          ) : currentQuestion !== null && currentDraft !== null ? (
            <AskQuestionField
              disabled={!canInteract || submitting}
              draft={currentDraft}
              formId={formId}
              question={currentQuestion}
              onChange={updateCurrentDraft}
              onSingleChoice={() => moveToStep(activeStep + 1)}
            />
          ) : null}
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
              disabled={!canInteract || submitting}
              onClick={() => void cancel()}
            >
              {localPending === 'cancel' ? '正在取消…' : '取消'}
            </button>
            {activeStep > 0 ? (
              <button
                className="ask-tool-back"
                type="button"
                disabled={submitting}
                onClick={() => moveToStep(activeStep - 1)}
              >
                {reviewing ? '返回上一题' : '上一题'}
              </button>
            ) : null}
          </div>
          <button
            className="ask-tool-submit"
            type="submit"
            disabled={
              !canInteract ||
              submitting ||
              (reviewing ? answers === null : !currentComplete)
            }
          >
            {ask.status === 'submitting' || localPending === 'submit'
              ? '正在提交…'
              : reviewing
                ? '提交回答'
                : lastQuestion
                  ? '检查回答'
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

function AskReviewStep({
  draft,
  formId,
  questions,
  onEdit
}: {
  draft: AnswerDraft
  formId: string
  questions: readonly KernelAskQuestion[]
  onEdit: (questionIndex: number) => void
}): React.JSX.Element {
  const missingCount = questions.reduce((count, question) => {
    const questionDraft = draft[question.id] ?? emptyQuestionDraft(question)
    return count + (isQuestionComplete(question, questionDraft) ? 0 : 1)
  }, 0)

  return (
    <section className="ask-review" aria-labelledby={`${formId}-review-title`}>
      <header className="ask-review-header">
        <h4 id={`${formId}-review-title`}>确认回答</h4>
        <p>提交前检查一下；点击任意问题可以返回修改。</p>
      </header>
      <ol className="ask-review-list">
        {questions.map((question, questionIndex) => {
          const questionDraft = draft[question.id] ?? emptyQuestionDraft(question)
          const summary = summarizeAskDraft(question, questionDraft)
          return (
            <li className={`ask-review-item${summary === null ? ' incomplete' : ''}`} key={question.id}>
              <div className="ask-review-copy">
                <span>第 {questionIndex + 1} 题</span>
                <strong>{question.prompt}</strong>
                <p>{summary ?? '尚未回答'}</p>
              </div>
              <button
                aria-label={`修改第 ${questionIndex + 1} 题：${question.prompt}`}
                className="ask-review-edit"
                type="button"
                onClick={() => onEdit(questionIndex)}
              >
                <Icon name="edit" size="sm" />
                修改
              </button>
            </li>
          )
        })}
      </ol>
      <p
        className={`ask-review-readiness${missingCount > 0 ? ' incomplete' : ''}`}
        role="status"
      >
        {missingCount > 0
          ? `还有 ${missingCount} 题未回答，完成后才能提交。`
          : '所有问题均已回答，可以提交。'}
      </p>
    </section>
  )
}

export function summarizeAskDraft(
  question: KernelAskQuestion,
  draft: QuestionDraft
): string | null {
  if (!isQuestionComplete(question, draft)) return null
  if (question.type === 'text') {
    return typeof draft.value === 'string' ? draft.value.trim() : null
  }
  if (question.type === 'single') {
    if (draft.customSelected) return draft.customValue.trim()
    if (typeof draft.value !== 'string') return null
    return question.options.find((option) => option.value === draft.value)?.label ?? null
  }
  if (!Array.isArray(draft.value)) return null
  const selectedValues = new Set(draft.value)
  const labels = question.options
    .filter((option) => selectedValues.has(option.value))
    .map((option) => option.label)
  if (draft.customSelected) labels.push(draft.customValue.trim())
  return labels.length > 0 ? labels.join('、') : null
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
