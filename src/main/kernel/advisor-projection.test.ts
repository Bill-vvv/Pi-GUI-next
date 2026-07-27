import assert from 'node:assert/strict'
import test from 'node:test'
import { projectAdvisorState } from './advisor-projection.ts'

function capabilities(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'custom',
    customType: 'pi-gui.multi-advisor/capabilities',
    data: {
      protocolVersion: 2,
      identity: 'pi-gui-multi-advisor',
      version: '1.2.3',
      enabled: true,
      multiAdvisor: true,
      liveToggle: true,
      roster: true,
      status: true,
      usage: true,
      dump: false,
      subagents: false,
      severities: ['nit', 'concern', 'blocker'],
      deliveries: ['aside', 'steer'],
      readOnlyTools: ['read', 'grep', 'find', 'ls'],
      optionalTools: ['edit', 'write'],
      ...overrides
    }
  }
}

test('projects the latest valid advisor capability without raw data', () => {
  const state = projectAdvisorState([
    capabilities({ version: '1.0.0', enabled: false }),
    { type: 'custom', customType: 'unrelated', data: { secret: true } },
    capabilities()
  ])

  assert.deepEqual(state, {
    compatibility: 'ready',
    extensionVersion: '1.2.3',
    systemEnabled: true,
    liveToggle: true,
    multiAdvisor: true,
    roster: true,
    error: null
  })
  assert.equal(JSON.stringify(state).includes('readOnlyTools'), false)
})

test('keeps historical protocol v2 usage:false capabilities compatible', () => {
  assert.equal(projectAdvisorState([capabilities({ usage: false })]).compatibility, 'ready')
  assert.equal(projectAdvisorState([capabilities({ usage: 'yes' })]).compatibility, 'incompatible')
})

test('reports unavailable when no advisor capability entry exists', () => {
  assert.deepEqual(projectAdvisorState([]), {
    compatibility: 'unavailable',
    extensionVersion: null,
    systemEnabled: null,
    liveToggle: false,
    multiAdvisor: false,
    roster: false,
    error: null
  })
})

test('reports a fixed incompatible state for malformed or unknown capabilities', () => {
  const state = projectAdvisorState([capabilities({
    protocolVersion: 1,
    usage: 'yes',
    privateDiagnostic: 'must not cross the boundary'
  })])

  assert.deepEqual(state, {
    compatibility: 'incompatible',
    extensionVersion: null,
    systemEnabled: null,
    liveToggle: false,
    multiAdvisor: false,
    roster: false,
    error: 'Advisor extension capabilities are incompatible.'
  })
  assert.equal(JSON.stringify(state).includes('privateDiagnostic'), false)
})
