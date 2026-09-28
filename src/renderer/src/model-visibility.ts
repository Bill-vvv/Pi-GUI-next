export const MODEL_VISIBILITY_STORAGE_KEY = 'pi-workbench.hidden-models'

export function modelVisibilityKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`
}

export function parseHiddenModelKeys(raw: string | null): ReadonlySet<string> {
  if (raw === null || raw.length === 0) return new Set()
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return new Set()
    return new Set(value)
  } catch {
    return new Set()
  }
}

/** Returns the hidden-key set after showing or hiding every listed model at once. */
export function withModelsVisible(
  hiddenKeys: ReadonlySet<string>,
  models: ReadonlyArray<{ provider: string; modelId: string }>,
  visible: boolean
): ReadonlySet<string> {
  const next = new Set(hiddenKeys)
  for (const { provider, modelId } of models) {
    const key = modelVisibilityKey(provider, modelId)
    if (visible) next.delete(key)
    else next.add(key)
  }
  return next
}

export function serializeHiddenModelKeys(keys: ReadonlySet<string>): string {
  return JSON.stringify([...keys].sort())
}

export function visiblePickerModels<T extends { provider: string; id: string }>(
  models: readonly T[],
  hiddenKeys: ReadonlySet<string>,
  current: { provider: string; id: string } | null
): T[] {
  return models.filter((model) => (
    !hiddenKeys.has(modelVisibilityKey(model.provider, model.id)) ||
    (
      current !== null &&
      model.provider === current.provider &&
      model.id === current.id
    )
  ))
}
