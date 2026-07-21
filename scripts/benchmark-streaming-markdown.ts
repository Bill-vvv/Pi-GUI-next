import { performance } from 'node:perf_hooks'

import {
  buildStreamingMarkdownModel,
  type StreamingMarkdownModel
} from '../src/renderer/src/features/chat/streaming-markdown.ts'

type BenchmarkResult = {
  scenario: string
  updates: number
  characters: number
  totalMs: number
  meanMs: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  finalBlockFormat: 'markdown' | 'plain-text' | null
}

function percentile(samples: number[], ratio: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}

function benchmark(
  scenario: string,
  updates: number,
  append: (text: string, index: number) => string
): BenchmarkResult {
  let text = ''
  let model: StreamingMarkdownModel | undefined
  const samples: number[] = []
  const totalStart = performance.now()

  for (let index = 0; index < updates; index += 1) {
    text = append(text, index)
    const start = performance.now()
    model = buildStreamingMarkdownModel(text, model)
    samples.push(performance.now() - start)
  }

  const totalMs = performance.now() - totalStart
  return {
    scenario,
    updates,
    characters: text.length,
    totalMs,
    meanMs: totalMs / updates,
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    maxMs: Math.max(...samples),
    finalBlockFormat: model?.blocks.at(-1)?.format ?? null
  }
}

const results = [
  benchmark('closed-paragraphs', 1_500, (text) => `${text}${'x'.repeat(69)}\n\n`),
  benchmark('single-paragraph', 1_500, (text) => `${text}${'x'.repeat(71)}`),
  benchmark('document-definition', 1_500, (text, index) => index === 0
    ? `[ref]: https://example.com\n\n${'x'.repeat(43)}`
    : `${text}${'x'.repeat(71)}`)
]

for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`)
