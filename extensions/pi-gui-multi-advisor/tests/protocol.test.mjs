import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ADVISORY_TYPE,
  CAPABILITY_TYPE,
  USAGE_EVENT,
  aggregateAssistantUsage,
  createAdvisory,
  createCapabilities,
  createUsageEvent,
  createEmissionGuard,
  serializeTurnDelta,
} from "../src/protocol.mjs";

test("advisory is escaped, versioned, and identifies the real advisor", () => {
  const advisory = createAdvisory('check <x> & "y"', "concern", 42, "aside", {
    slug: "security-review",
    name: "Security Review",
  });
  assert.equal(advisory.customType, ADVISORY_TYPE);
  assert.equal(advisory.details.protocolVersion, 2);
  assert.equal(advisory.details.advisorSlug, "security-review");
  assert.equal(advisory.details.advisorName, "Security Review");
  assert.equal(advisory.details.note, 'check <x> & "y"');
  assert.equal(advisory.details.timestamp, 42);
  assert.equal(advisory.details.delivery, "aside");
  assert.match(advisory.content, /guidance="weigh, don&apos;t blindly obey"/);
  assert.match(advisory.content, /advisor="security-review"/);
  assert.match(advisory.content, /check &lt;x&gt; &amp; &quot;y&quot;/);
});

test("emission guard permits one item per review and only real escalation later", () => {
  const guard = createEmissionGuard();
  guard.beginReview();
  assert.equal(guard.accept("Fix   this", "nit"), true);
  assert.equal(guard.accept("Another", "blocker"), false);
  guard.beginReview();
  assert.equal(guard.accept(" fix this ", "nit"), false);
  assert.equal(guard.accept("FIX THIS", "concern"), true);
  guard.beginReview();
  assert.equal(guard.accept("fix this", "blocker"), true);
});

test("turn delta filters the extension's own advisory", () => {
  const serialized = serializeTurnDelta({
    prompt: "primary",
    message: { customType: ADVISORY_TYPE, content: "self" },
    toolResults: [
      { type: ADVISORY_TYPE, content: "self" },
      { role: "toolResult", content: "primary result" },
    ],
  });
  const value = JSON.parse(serialized);
  assert.equal("message" in value, false);
  assert.deepEqual(value.toolResults, [{ role: "toolResult", content: "primary result" }]);
});

test("capability truthfully describes the S18-3 surface", () => {
  const capability = createCapabilities(false);
  assert.equal(CAPABILITY_TYPE, "pi-gui.multi-advisor/capabilities");
  assert.deepEqual(capability, {
    protocolVersion: 2,
    identity: "pi-gui-multi-advisor",
    version: "0.2.0",
    enabled: false,
    multiAdvisor: true,
    liveToggle: true,
    roster: true,
    status: true,
    usage: true,
    dump: false,
    subagents: false,
    severities: ["nit", "concern", "blocker"],
    deliveries: ["aside", "steer"],
    readOnlyTools: ["read", "grep", "find", "ls"],
    optionalTools: ["edit", "write"],
  });
});

test("usage telemetry aggregates only assistant model turns", () => {
  const messages = [
    { role: "user", usage: { input: 999 } },
    {
      role: "assistant",
      usage: {
        input: 100,
        output: 20,
        cacheRead: 50,
        cacheWrite: 5,
        reasoning: 8,
        totalTokens: 175,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
      },
    },
    {
      role: "assistant",
      usage: {
        input: 40,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 50,
        cost: { input: 0.04, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.14 },
      },
    },
  ];
  assert.deepEqual(aggregateAssistantUsage(messages), {
    input: 140,
    output: 30,
    cacheRead: 50,
    cacheWrite: 5,
    reasoning: 8,
    totalTokens: 225,
    cost: { input: 0.14, output: 0.30000000000000004, cacheRead: 0.01, cacheWrite: 0.02, total: 0.47000000000000003 },
    turns: 2,
  });

  const event = createUsageEvent(
    { slug: "security", name: "Security" },
    { provider: "provider", id: "model" },
    "completed",
    100,
    250,
    messages,
  );
  assert.equal(USAGE_EVENT, "pi-gui.multi-advisor/usage");
  assert.equal(event.protocolVersion, 2);
  assert.equal(event.identity, "pi-gui-multi-advisor");
  assert.equal(event.advisorSlug, "security");
  assert.equal(event.durationMs, 150);
  assert.equal(event.usage.turns, 2);
});

test("frozen WATCHDOG schema has the baseline fields and slug rule", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../schemas/watchdog.schema.json", import.meta.url), "utf8"),
  );
  assert.match(schema.$id, /667111575ebba136dadfd6989379e7f67e0d40d9/);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["advisors", "instructions"]);
  assert.deepEqual(schema.properties.advisors.items.required, ["name"]);
  assert.deepEqual(
    Object.keys(schema.properties.advisors.items.properties).sort(),
    ["enabled", "instructions", "model", "name", "thinking", "tools"],
  );
  assert.match(schema.description, /lowercasing/);
  assert.match(schema.description, /falls back to advisor/);
  assert.equal("minLength" in schema.properties.advisors.items.properties.name, false);
  assert.equal("uniqueItems" in schema.properties.advisors.items.properties.tools, false);
});
