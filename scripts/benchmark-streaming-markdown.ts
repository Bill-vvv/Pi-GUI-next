import { performance } from 'node:perf_hooks'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  buildStreamingMarkdownModel,
  type StreamingMarkdownModel
} from '../src/renderer/src/features/chat/streaming-markdown.ts'

type BenchmarkResult = {
  kind: 'model' | 'render'
  scenario: string
  updates: number
  characters: number
  totalMs: number
  meanMs: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  finalWholeDocument: boolean | null
}

function percentile(samples: number[], ratio: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}

function benchmarkModel(
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
    kind: 'model',
    scenario,
    updates,
    characters: text.length,
    totalMs,
    meanMs: totalMs / updates,
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    maxMs: Math.max(...samples),
    finalWholeDocument: model?.wholeDocument ?? null
  }
}

function benchmarkRender(
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
    const nextModel = buildStreamingMarkdownModel(text, model)
    for (const block of nextModel.blocks) {
      const unchanged = model?.blocks.some((candidate) => (
        candidate.id === block.id && candidate.text === block.text
      )) ?? false
      if (unchanged) continue
      renderToStaticMarkup(createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm] },
        block.text
      ))
    }
    model = nextModel
    samples.push(performance.now() - start)
  }

  const totalMs = performance.now() - totalStart
  return {
    kind: 'render',
    scenario,
    updates,
    characters: text.length,
    totalMs,
    meanMs: totalMs / updates,
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    maxMs: Math.max(...samples),
    finalWholeDocument: model?.wholeDocument ?? null
  }
}

const modelResults = [
  benchmarkModel('closed-paragraphs', 1_500, (text) => `${text}${'x'.repeat(69)}\n\n`),
  benchmarkModel('single-paragraph', 1_500, (text) => `${text}${'x'.repeat(71)}`),
  benchmarkModel('document-definition', 1_500, (text, index) => index === 0
    ? `[ref]: https://example.com\n\n${'x'.repeat(43)}`
    : `${text}${'x'.repeat(71)}`)
]

const renderResults = [
  benchmarkRender('closed-paragraphs', 300, (text) => `${text}${'x'.repeat(353)}\n\n`),
  benchmarkRender('single-paragraph', 300, (text) => `${text}${'x'.repeat(355)}`),
  benchmarkRender('document-definition', 300, (text, index) => index === 0
    ? `[ref]: https://example.com\n\n${'x'.repeat(327)}`
    : `${text}${'x'.repeat(355)}`)
]

for (const result of [...modelResults, ...renderResults]) {
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
