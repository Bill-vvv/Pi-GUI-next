import type { KernelSubagentDefinition } from '../../shared/kernel-contract.ts'

type SubagentDefinitionSource = {
  definition: KernelSubagentDefinition
  filePath: string
  parsed: { frontmatter: Map<string, string>; blockKeys: Set<string>; body: string }
}

/** Native defaults replace same-name package defaults; other legacy roles stay available. */
export function builtinSubagentDefinitionSources(legacy: SubagentDefinitionSource[]): SubagentDefinitionSource[] {
  const native = nativeSubagentDefinitions().map((definition) => ({
    definition,
    filePath: `native:${definition.name}`,
    parsed: { frontmatter: new Map<string, string>(), blockKeys: new Set<string>(), body: definition.systemPrompt }
  }))
  const nativeNames = new Set(native.map(({ definition }) => definition.name))
  return [...legacy.filter(({ definition }) => !nativeNames.has(definition.name)), ...native]
}

/** App-owned defaults; user and project Markdown definitions can override by name. */
function nativeSubagentDefinitions(): KernelSubagentDefinition[] {
  return [
    {
      name: 'worker',
      description: '完成明确的实现、修复或执行任务',
      systemPrompt: 'You are a worker agent. Complete the assigned task within its stated scope. Inspect relevant context, preserve unrelated work, and report the concrete changes and verification. Do not broaden the task without a reason.',
      tools: null
    },
    {
      name: 'scout',
      description: '检索代码与材料，定位事实和实现入口',
      systemPrompt: 'You are a scout agent. Inspect the relevant code and materials, identify the facts and implementation entry points, and report concise findings with file references. Do not modify files.',
      tools: ['read', 'grep', 'find', 'ls']
    },
    {
      name: 'reviewer',
      description: '检查变更的正确性，报告可操作问题',
      systemPrompt: 'You are a reviewer agent. Review the assigned changes for concrete correctness defects and regressions. Inspect related code before drawing conclusions. Report actionable findings with evidence and file references; clearly say when no defect is found. Do not modify files.',
      tools: ['read', 'grep', 'find', 'ls']
    }
  ].map<KernelSubagentDefinition>((definition) => ({
    ...definition,
    id: `builtin:native:${definition.name}`,
    scope: 'builtin',
    editable: false,
    enabled: true,
    model: null,
    fallbackModels: null,
    thinking: null,
    systemPromptMode: 'append',
    inheritProjectContext: true,
    inheritSkills: false,
    defaultContext: 'fresh',
    skills: null,
    defaultAsync: true,
    timeoutMs: null,
    maxTurns: null,
    maxSubagentDepth: null
  }))
}
