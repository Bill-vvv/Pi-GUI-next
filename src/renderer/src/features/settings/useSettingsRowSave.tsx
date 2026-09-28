import { useCallback, useEffect, useRef, useState } from 'react'

import { unknownErrorMessage } from '../../unknown-error-message'

type RowFailure = {
  rowId: string
  message: string
}

/**
 * Immediate-apply preferences report failures on the row that started the save.
 * Only the latest save may publish a failure; starting another save clears it.
 */
export function useSettingsRowSave(): {
  save: (rowId: string, operation: () => Promise<void>) => void
  errorFor: (rowId: string) => string | null
} {
  const [failure, setFailure] = useState<RowFailure | null>(null)
  const revisionRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const save = useCallback((rowId: string, operation: () => Promise<void>) => {
    const revision = revisionRef.current + 1
    revisionRef.current = revision
    setFailure(null)
    void operation().catch((error: unknown) => {
      if (!mountedRef.current || revisionRef.current !== revision) return
      setFailure({ rowId, message: unknownErrorMessage(error) })
    })
  }, [])

  const errorFor = useCallback(
    (rowId: string) => (failure?.rowId === rowId ? failure.message : null),
    [failure]
  )

  return { save, errorFor }
}

export function SettingsRowError({ message }: { message: string | null }): React.JSX.Element | null {
  if (message === null) return null
  return (
    <p className="settings-feedback settings-feedback-error" role="alert">
      保存失败：{message}
    </p>
  )
}
