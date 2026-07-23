export const TOOL_DISPLAY_DENSITIES = ['compact', 'standard', 'detailed'] as const

export type ToolDisplayDensity = typeof TOOL_DISPLAY_DENSITIES[number]

export const DEFAULT_TOOL_DISPLAY_DENSITY: ToolDisplayDensity = 'standard'

export function isToolDisplayDensity(value: string | null): value is ToolDisplayDensity {
  return TOOL_DISPLAY_DENSITIES.some((density) => density === value)
}
