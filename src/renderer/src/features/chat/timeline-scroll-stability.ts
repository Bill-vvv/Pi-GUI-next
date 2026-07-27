export type TimelineScrollMode = 'following' | 'reading'

export const TIMELINE_LAYOUT_CHANGE_EVENT = 'pi-gui:timeline-layout-change'
export const OUTPUT_END_EPSILON_PX = 2

export function timelineScrollModeAfterScroll({
  currentMode,
  previousScrollTop,
  scrollTop,
  outputEndScrollTop,
  suppressUserIntent
}: {
  currentMode: TimelineScrollMode
  previousScrollTop: number
  scrollTop: number
  outputEndScrollTop: number | null
  suppressUserIntent: boolean
}): TimelineScrollMode {
  if (suppressUserIntent) return currentMode
  if (scrollTop < previousScrollTop - 0.5) return 'reading'
  if (
    outputEndScrollTop !== null &&
    Math.abs(scrollTop - outputEndScrollTop) <= OUTPUT_END_EPSILON_PX
  ) {
    return 'following'
  }
  return currentMode
}

export function anchoredTimelineScrollTop({
  scrollTop,
  previousAnchorViewportOffset,
  currentAnchorViewportOffset
}: {
  scrollTop: number
  previousAnchorViewportOffset: number
  currentAnchorViewportOffset: number
}): number {
  return Math.max(
    0,
    scrollTop + currentAnchorViewportOffset - previousAnchorViewportOffset
  )
}

export function isTimelineViewportMeasurable({
  width,
  height
}: {
  width: number
  height: number
}): boolean {
  return width > 0.5 && height > 0.5
}
