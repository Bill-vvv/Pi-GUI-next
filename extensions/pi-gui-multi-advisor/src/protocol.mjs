import {
  ADVISOR_MAX_ADVICE_CHARS,
  ADVISOR_MAX_DEDUPE_ENTRIES,
} from "./resilience.mjs";

export const PROTOCOL_VERSION = 2;
export const STATE_VERSION = 1;
export const CAPABILITY_TYPE = "pi-gui.multi-advisor/capabilities";
export const ADVISORY_TYPE = "pi-gui.multi-advisor/advisory";
export const USAGE_EVENT = "pi-gui.multi-advisor/usage";
export const SEVERITIES = Object.freeze(["nit", "concern", "blocker"]);
export const DELIVERIES = Object.freeze(["aside", "steer"]);
export const READ_ONLY_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
export const OPTIONAL_TOOLS = Object.freeze(["edit", "write"]);

const CONTENT_FREE_NOTES = new Set([
  "stop",
  "stop here",
  "stop now",
  "halt",
  "abort",
  "done",
  "task done",
  "task complete",
  "complete",
  "finished",
  "ok",
  "okay",
  "ok done",
  "no issue",
  "no issues",
  "no issue continue",
  "no concerns",
  "no concern",
  "nothing to add",
  "nothing to flag",
  "nothing to report",
  "no notes",
  "no further input",
  "no further input needed",
  "no further input required",
  "no further watcher input",
  "no further watcher input needed",
  "no further advice",
  "no further advice needed",
  "lgtm",
  "looks good",
  "all good",
  "agent is on track",
  "agent on track",
  "on track",
  "continue",
  "carry on",
]);

export function parseState(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== STATE_VERSION ||
    typeof value.enabled !== "boolean"
  ) {
    throw new Error("Invalid pi-gui-multi-advisor state: expected exactly {version:1,enabled:boolean}");
  }
  return Object.freeze({ version: STATE_VERSION, enabled: value.enabled });
}

export function parseStateText(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid pi-gui-multi-advisor state JSON: ${error.message}`);
  }
  return parseState(value);
}

export function normalizeNote(note) {
  return note
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function createEmissionGuard() {
  const acceptedNotes = new Set();
  const acceptedOrder = [];
  let emittedThisReview = false;

  return {
    beginReview() {
      emittedThisReview = false;
    },
    accept(note, severity) {
      if (emittedThisReview) return false;
      if (typeof note !== "string" || !SEVERITIES.includes(severity)) return false;
      const normalized = normalizeNote(note);
      if (normalized.length === 0 || CONTENT_FREE_NOTES.has(normalized)) return false;
      if (acceptedNotes.has(normalized)) return false;

      acceptedNotes.add(normalized);
      acceptedOrder.push(normalized);
      if (acceptedOrder.length > ADVISOR_MAX_DEDUPE_ENTRIES) {
        acceptedNotes.delete(acceptedOrder.shift());
      }
      emittedThisReview = true;
      return true;
    },
    reset() {
      acceptedNotes.clear();
      acceptedOrder.length = 0;
      emittedThisReview = false;
    },
  };
}

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function createAdvisory(
  note,
  severity,
  timestamp = Date.now(),
  delivery = "aside",
  advisor = { slug: "default-advisor", name: "Default Advisor" },
) {
  if (
    typeof note !== "string" ||
    note.trim().length === 0 ||
    note.length > ADVISOR_MAX_ADVICE_CHARS ||
    note.includes("\0")
  ) {
    throw new Error(`Advisory note must contain 1-${ADVISOR_MAX_ADVICE_CHARS} safe characters`);
  }
  if (!SEVERITIES.includes(severity)) {
    throw new Error(`Unsupported advisory severity: ${severity}`);
  }
  if (!DELIVERIES.includes(delivery)) {
    throw new Error(`Unsupported advisory delivery: ${delivery}`);
  }

  const guidance = "weigh, don't blindly obey";
  const details = {
    protocolVersion: PROTOCOL_VERSION,
    advisorSlug: advisor.slug,
    advisorName: advisor.name,
    note: note.trim(),
    severity,
    guidance,
    delivery,
    timestamp,
  };
  const content =
    `<advisory advisor="${escapeXml(advisor.slug)}" severity="${escapeXml(severity)}" ` +
    `guidance="${escapeXml(guidance)}">${escapeXml(note.trim())}</advisory>`;

  return {
    customType: ADVISORY_TYPE,
    content,
    display: true,
    details,
  };
}

export function createCapabilities(enabled) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    identity: "pi-gui-multi-advisor",
    version: "0.3.0",
    enabled,
    multiAdvisor: true,
    liveToggle: true,
    roster: true,
    status: true,
    usage: true,
    dump: false,
    subagents: false,
    severities: [...SEVERITIES],
    deliveries: [...DELIVERIES],
    readOnlyTools: [...READ_ONLY_TOOLS],
    optionalTools: [...OPTIONAL_TOOLS],
  };
}

export function aggregateAssistantUsage(messages) {
  const total = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    turns: 0,
  };
  for (const message of messages ?? []) {
    if (message?.role !== "assistant" || !message.usage || typeof message.usage !== "object") {
      continue;
    }
    const usage = message.usage;
    total.input += finiteNumber(usage.input);
    total.output += finiteNumber(usage.output);
    total.cacheRead += finiteNumber(usage.cacheRead);
    total.cacheWrite += finiteNumber(usage.cacheWrite);
    total.reasoning += finiteNumber(usage.reasoning);
    total.totalTokens += finiteNumber(usage.totalTokens);
    if (usage.cost && typeof usage.cost === "object") {
      total.cost.input += finiteNumber(usage.cost.input);
      total.cost.output += finiteNumber(usage.cost.output);
      total.cost.cacheRead += finiteNumber(usage.cost.cacheRead);
      total.cost.cacheWrite += finiteNumber(usage.cost.cacheWrite);
      total.cost.total += finiteNumber(usage.cost.total);
    }
    total.turns += 1;
  }
  return total;
}

export function createUsageEvent(
  advisor,
  model,
  status,
  startedAt,
  endedAt,
  messages = [],
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    identity: "pi-gui-multi-advisor",
    advisorSlug: advisor.slug,
    advisorName: advisor.name,
    provider: model?.provider ?? null,
    model: model?.id ?? null,
    status,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    usage: aggregateAssistantUsage(messages),
  };
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function isOwnAdvisory(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    (value.customType === ADVISORY_TYPE || value.type === ADVISORY_TYPE)
  );
}

export function serializeTurnDelta(input) {
  const filteredToolResults = (input.toolResults ?? []).filter((item) => !isOwnAdvisory(item));
  const message = isOwnAdvisory(input.message) ? undefined : input.message;
  return JSON.stringify({
    prompt: input.prompt,
    message,
    toolResults: filteredToolResults,
  });
}
