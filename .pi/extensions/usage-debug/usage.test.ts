import assert from "node:assert/strict"
import test from "node:test"
import {
  createUsageDebugState,
  formatSnapshot,
  normalizeTokenUsage,
  recordAdvisorUsageEvent,
  recordMagicContextUsageEvent,
  recordSubagentCompletionEvent,
  recordSubagentPayload,
  refreshAdvisorEnabled,
  sampleContextUsage,
} from "./usage.ts"

test("normalizes Pi and pi-subagents usage shapes", () => {
  assert.deepEqual(normalizeTokenUsage({
    inputTokens: 10,
    outputTokens: 4,
    cacheRead: 20,
    cacheWrite: 2,
    cost: { total: 0.125 },
  }), {
    input: 10,
    output: 4,
    cacheRead: 20,
    cacheWrite: 2,
    cost: 0.125,
    turns: 0,
  })
  assert.deepEqual(normalizeTokenUsage({ input: 5, output: 2, cost: 0.01, turns: 1 }), {
    input: 5,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.01,
    turns: 1,
  })
  assert.equal(normalizeTokenUsage({ input: 0, output: 0 }), null)
})

test("deduplicates child usage across tool and completion payloads", () => {
  const state = createUsageDebugState(1)
  const payload = {
    runId: "run-1",
    results: [
      { agent: "worker", usage: { input: 100, output: 25, cacheRead: 5, cacheWrite: 1, cost: 0.2, turns: 2 } },
      { agent: "reviewer", usage: { input: 50, output: 10, cost: 0.1, turns: 1 } },
    ],
  }

  assert.deepEqual(recordSubagentPayload(state, payload, "fallback"), { completions: 2, metered: 2 })
  assert.deepEqual(recordSubagentPayload(state, payload, "fallback"), { completions: 0, metered: 0 })
  recordSubagentCompletionEvent(state, { ...payload, id: "run-1" }, "fallback")

  assert.equal(state.subagent.runsStarted, 1)
  assert.equal(state.subagent.runsCompleted, 2)
  assert.equal(state.subagent.unmeteredCompletions, 0)
  assert.deepEqual(state.subagent.usage, {
    input: 150,
    output: 35,
    cacheRead: 5,
    cacheWrite: 1,
    cost: 0.30000000000000004,
    turns: 3,
  })
})

test("marks completion events without usage as uncovered", () => {
  const state = createUsageDebugState(1)
  recordSubagentCompletionEvent(state, {
    id: "run-2:0",
    runId: "run-2",
    source: "foreground",
    state: "complete",
  }, "fallback")
  recordSubagentCompletionEvent(state, {
    id: "run-2:0",
    runId: "run-2",
    source: "foreground",
    state: "complete",
  }, "fallback")

  assert.equal(state.subagent.runsStarted, 1)
  assert.equal(state.subagent.runsCompleted, 1)
  assert.equal(state.subagent.unmeteredCompletions, 1)
  assert.deepEqual(state.subagent.activeRunIds, [])
})

test("tracks latest Advisor capability and context pressure", () => {
  const state = createUsageDebugState(1)
  refreshAdvisorEnabled(state, [
    { type: "custom", customType: "pi-gui.multi-advisor/capabilities", data: { identity: "pi-gui-multi-advisor", enabled: false } },
    { type: "custom", customType: "pi-gui.multi-advisor/capabilities", data: { identity: "pi-gui-multi-advisor", enabled: true } },
  ])
  sampleContextUsage(state, { tokens: 50_000, contextWindow: 200_000, percent: 25 })
  sampleContextUsage(state, { tokens: 80_000, contextWindow: 200_000 })

  assert.equal(state.advisor.enabled, true)
  assert.deepEqual(state.magicContext.lastContextUsage, {
    tokens: 80_000,
    contextWindow: 200_000,
    percent: 40,
  })
  assert.equal(state.magicContext.maxContextPercent, 40)
})

test("records and deduplicates exact Advisor usage events", () => {
  const state = createUsageDebugState(1)
  const event = {
    protocolVersion: 2,
    identity: "pi-gui-multi-advisor",
    advisorSlug: "security",
    status: "completed",
    startedAt: 100,
    usage: { input: 120, output: 30, cacheRead: 50, cacheWrite: 5, turns: 2, cost: { total: 0.42 } },
  }
  assert.equal(recordAdvisorUsageEvent(state, event), true)
  assert.equal(recordAdvisorUsageEvent(state, event), false)
  assert.equal(state.advisor.reviewsCompleted, 1)
  assert.deepEqual(state.advisor.usage, {
    input: 120,
    output: 30,
    cacheRead: 50,
    cacheWrite: 5,
    cost: 0.42,
    turns: 2,
  })
})

test("records and deduplicates Magic Context child-model usage", () => {
  const state = createUsageDebugState(1)
  const event = {
    version: 1,
    identity: "@cortexkit/pi-magic-context",
    sessionId: "session-1",
    invocationId: 17,
    subagent: "historian",
    status: "completed",
    startedAt: 100,
    usage: { input: 1_000, output: 200, cacheRead: 500, cacheWrite: 10, turns: 1 },
  }
  assert.equal(recordMagicContextUsageEvent(state, event), true)
  assert.equal(recordMagicContextUsageEvent(state, event), false)
  assert.equal(state.magicContext.modelRuns, 1)
  assert.deepEqual(state.magicContext.subagents, { historian: 1 })
  assert.deepEqual(state.magicContext.modelUsage, {
    input: 1_000,
    output: 200,
    cacheRead: 500,
    cacheWrite: 10,
    cost: 0,
    turns: 1,
  })
})

test("status includes exact Advisor and Magic Context model accounting", () => {
  const state = createUsageDebugState(1)
  recordAdvisorUsageEvent(state, {
    protocolVersion: 2,
    identity: "pi-gui-multi-advisor",
    advisorSlug: "default",
    status: "completed",
    startedAt: 10,
    usage: { input: 100, output: 20, turns: 1, cost: { total: 0.1 } },
  })
  recordMagicContextUsageEvent(state, {
    version: 1,
    identity: "@cortexkit/pi-magic-context",
    sessionId: "session-1",
    invocationId: 1,
    subagent: "historian",
    status: "completed",
    startedAt: 20,
    usage: { input: 200, output: 40, turns: 1 },
  })
  const text = formatSnapshot(state, "/tmp/aggregate.jsonl", 61_001)
  assert.match(text, /Advisor:.*100 in \/ 20 out.*\$0\.1000/u)
  assert.match(text, /model runs historian=1.*200 in \/ 40 out/u)
  assert.doesNotMatch(text, /unavailable/u)
  assert.match(text, /Aggregate-only log: \/tmp\/aggregate\.jsonl/u)
})
