import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('./features/settings/SubagentSettings.tsx', import.meta.url),
  'utf8'
)

test('labels Agent availability as enabled rather than running', () => {
  assert.doesNotMatch(source, /已启动|未启动|启动状态/u)
  assert.match(source, /启用状态/u)
  assert.match(source, /已启用/u)
  assert.match(source, /已停用/u)
})

test('makes the complete paginated Agent result count visible', () => {
  assert.match(source, /共 \{filteredDefinitions\.length\} 个/u)
  assert.match(source, /\{page \+ 1\} \/ \{pageCount\}/u)
})

test('sorts effective Agent definitions by runtime name', () => {
  assert.match(
    source,
    /\[\.\.\.definitionsByName\.values\(\)\]\.sort\(\(left, right\) =>[\s\S]*?left\.name\.localeCompare\(right\.name\)/u
  )
})
