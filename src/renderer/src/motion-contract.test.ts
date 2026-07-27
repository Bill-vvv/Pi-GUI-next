import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rendererRoot = dirname(fileURLToPath(import.meta.url))

function read(relativePath: string): string {
  return readFileSync(join(rendererRoot, relativePath), 'utf8')
}

function cssSources(directory = rendererRoot): Array<{ path: string; source: string }> {
  const sources: Array<{ path: string; source: string }> = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      sources.push(...cssSources(path))
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      sources.push({ path, source: readFileSync(path, 'utf8') })
    }
  }
  return sources
}

function rule(source: string, selector: string): string {
  const selectorStart = source.indexOf(`${selector} {`)
  assert.notEqual(selectorStart, -1, `Missing CSS rule ${selector}`)
  const bodyStart = source.indexOf('{', selectorStart)
  const bodyEnd = source.indexOf('}', bodyStart)
  assert.notEqual(bodyEnd, -1, `Unclosed CSS rule ${selector}`)
  return source.slice(bodyStart + 1, bodyEnd)
}

test('motion foundation exposes the four shared durations and two shared easings', () => {
  const tokens = read('tokens.css')
  for (const token of [
    '--motion-duration-tooltip',
    '--motion-duration-fast',
    '--motion-duration-control',
    '--motion-duration-layout',
    '--motion-easing-standard',
    '--motion-easing-layout'
  ]) {
    assert.match(tokens, new RegExp(`${token}:`), `Missing ${token}`)
  }
})

test('ordinary transitions use motion tokens instead of raw timing values', () => {
  for (const { path, source } of cssSources()) {
    for (const match of source.matchAll(/transition\s*:\s*([^;]+);/g)) {
      const declaration = match[1]!.replace(/visibility\s+0s\s+linear/g, '')
      assert.doesNotMatch(
        declaration,
        /(?:^|[\s,(])\d*\.?\d+(?:ms|s)\b/,
        `Raw transition duration in ${path}: ${match[0]}`
      )
      assert.doesNotMatch(
        declaration,
        /\b(?:ease|ease-in|ease-out|ease-in-out|linear|cubic-bezier\([^)]*\))\b/,
        `Raw transition easing in ${path}: ${match[0]}`
      )
    }
  }
})

test('Timeline width and Composer clearance never interpolate intrinsic grid geometry', () => {
  const workbench = read('composition/workbench.css')
  const composer = read('features/composer/composer.css')

  assert.doesNotMatch(rule(workbench, '.app-shell'), /transition\s*:/)
  assert.doesNotMatch(rule(workbench, '.main-chat'), /transition\s*:/)
  assert.doesNotMatch(rule(composer, '.composer-todo-body'), /transition\s*:/)

  for (const { path, source } of cssSources()) {
    for (const match of source.matchAll(/transition\s*:\s*([^;]+);/g)) {
      assert.doesNotMatch(
        match[1]!,
        /grid-template-(?:columns|rows)/,
        `Intrinsic grid transition can move Timeline content in ${path}: ${match[0]}`
      )
    }
  }
})

test('continuous activity animations have explicit static reduced-motion states', () => {
  const styles = read('styles.css')
  const composer = read('features/composer/composer.css')
  const chat = read('features/chat/chat.css')
  const project = read('features/project/project.css')

  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.screen-loading::before\s*\{[\s\S]*?animation:\s*none;/
  )
  assert.match(
    composer,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.composer-todo-state-icon\.active\s*\{[\s\S]*?animation:\s*none;/
  )
  assert.match(
    chat,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.thinking-core,[\s\S]*?animation:\s*none;/
  )
  assert.match(
    project,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.project-activity-trace > span,[\s\S]*?\.session-spinner-visual\s*\{[\s\S]*?animation:\s*none;/
  )

  const allowedActivityAnimations = new Set([
    'composer-todo-loading',
    'loading-pulse',
    'project-activity-trace',
    'session-orbit-turn',
    'thinking-wave-breathe'
  ])
  for (const { path, source } of cssSources()) {
    for (const match of source.matchAll(/animation\s*:\s*([\w-]+)[^;]*\binfinite\b[^;]*;/g)) {
      assert.equal(
        allowedActivityAnimations.has(match[1]!),
        true,
        `Unclassified continuous activity animation in ${path}: ${match[0]}`
      )
    }
  }
})

test('animated activity keeps text, ARIA, shape, or color semantics when motion stops', () => {
  const app = read('App.tsx')
  const todoPanel = read('features/composer/TodoPanel.tsx')
  const timeline = read('features/chat/TimelineTurns.tsx')
  const navigator = read('features/project/ProjectNavigator.tsx')

  assert.match(app, /<main className="screen-loading">\s*正在连接 Pi Workbench…/)
  assert.match(todoPanel, /className=\{`composer-todo-state-icon \$\{status\.tone\}`\}[\s\S]*?role="status"[\s\S]*?aria-label=\{status\.label\}/)
  assert.match(timeline, /className="thinking-status" aria-label=\{`Pi \$\{label\}`\} role="status"[\s\S]*?<span>\{label\}<\/span>/)
  assert.match(navigator, /className="project-activity-summary"[\s\S]*?role="status"[\s\S]*?aria-label=\{`有 \$\{busySessionCount\} 个对话进行中`\}/)
  assert.match(navigator, /className=\{`session-lifecycle-indicator \$\{status\}`\}[\s\S]*?role="status"[\s\S]*?aria-label=\{label\}/)
})
