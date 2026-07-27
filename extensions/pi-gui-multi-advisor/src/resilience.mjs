export const ADVISOR_IMMUNE_TURNS = 3;
export const ADVISOR_MAX_ADVICE_CHARS = 30_000;
export const ADVISOR_MAX_DEDUPE_ENTRIES = 4_096;
export const ADVISOR_MAX_QUEUED_REVIEW_AGE_MS = 30_000;
export const ADVISOR_MAX_REVIEW_ATTEMPTS = 3;
export const ADVISOR_CONTEXT_RESERVE_TOKENS = 16_384;

const STALE_ADVICE_SUFFIX =
  "\n\n_(Newer primary turns arrived after this review started; verify that this still applies.)_";
const ADVISOR_QUARANTINE_PREFIX = "Advisor response quarantined";
const ADVISOR_OUTPUT_ONLY_HAZARDS = [
  { label: "account-deletion claim", pattern: /\buser\b.{0,80}\b(?:deleted|erased)\b.{0,80}\baccount\b/i },
  {
    label: "instruction override",
    pattern: /\bignore\s+(?:all\s+)?(?:prior|previous|earlier)\s+(?:user\s+)?instructions\b/i,
  },
  { label: "destructive shell command", destructiveShell: true },
  { label: "denial instruction", pattern: /\bdeny\s+(?:this|it|the\s+request)\s+if\s+(?:asked|questioned)\b/i },
];

export class AdvisorLifecycleAbortedError extends Error {
  constructor(message = "advisor aborted by lifecycle reset") {
    super(message);
    this.name = "AdvisorLifecycleAbortedError";
  }
}

export function buildAdvisorQuarantineSourceText(currentInput, messages) {
  const parts = [];
  if (currentInput) parts.push(String(currentInput));
  for (const message of messages ?? []) {
    if (message?.role !== "toolResult" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

export function quarantineAdvisorUnsafeOutput(message, availableToolNames, sourceText = "") {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const reasons = [];
  const unavailableToolNames = new Set();
  const generatedParts = [];
  for (const block of message.content) {
    if (block?.type === "toolCall") {
      if (!availableToolNames.has(block.name)) unavailableToolNames.add(String(block.name));
      if (
        block.name === "advise" &&
        block.arguments &&
        typeof block.arguments.note === "string"
      ) generatedParts.push(block.arguments.note);
    }
    if (block?.type === "text" && typeof block.text === "string") generatedParts.push(block.text);
  }
  if (unavailableToolNames.size > 0) {
    const names = [...unavailableToolNames].sort();
    reasons.push(`requested unavailable ${names.length === 1 ? "tool" : "tools"} ${names.join(", ")}`);
  }

  const generatedText = generatedParts.join("\n");
  if (generatedText) {
    const generatedLabels = [];
    const matchedLabels = [];
    for (const hazard of ADVISOR_OUTPUT_ONLY_HAZARDS) {
      const generatedMatches = findHazardMatches(hazard, generatedText);
      if (generatedMatches.length === 0) continue;
      matchedLabels.push(hazard.label);
      const sourceMatches = new Set(
        findHazardMatches(hazard, sourceText).map(normalizeHazardProvenance),
      );
      if (generatedMatches.some((match) => !sourceMatches.has(normalizeHazardProvenance(match)))) {
        generatedLabels.push(hazard.label);
      }
    }
    if (
      matchedLabels.includes("destructive shell command") &&
      generatedLabels.includes("instruction override") &&
      !generatedLabels.includes("destructive shell command")
    ) generatedLabels.push("destructive shell command");
    if (generatedLabels.includes("destructive shell command") || generatedLabels.length >= 3) {
      reasons.push(`generated output-only destructive directives: ${generatedLabels.join(", ")}`);
    }
  }
  if (reasons.length === 0) return undefined;

  const reason = `${ADVISOR_QUARANTINE_PREFIX}: ${reasons.join("; ")}`;
  message.content = [{ type: "text", text: reason }];
  message.stopReason = "error";
  message.errorMessage = reason;
  delete message.stopDetails;
  delete message.toolCallAbortMessages;
  delete message.providerPayload;
  return reason;
}

export function isAdvisorInterruptImmuneTurnActive({
  completedTurns,
  immuneTurnStart,
  immuneTurns = ADVISOR_IMMUNE_TURNS,
}) {
  if (!Number.isInteger(completedTurns) || completedTurns < 0) return false;
  if (!Number.isInteger(immuneTurnStart) || immuneTurnStart < 0) return false;
  if (!Number.isInteger(immuneTurns) || immuneTurns <= 0) return false;
  return completedTurns < immuneTurnStart + immuneTurns;
}

export function resolveAdvisorDelivery({ severity, idle, interruptImmuneTurnActive }) {
  if (severity === "nit" || idle || interruptImmuneTurnActive) return "aside";
  return "steer";
}

export function isQueuedReviewExpired(review, now = Date.now()) {
  return !review ||
    !Number.isFinite(review.queuedAt) ||
    now - review.queuedAt > ADVISOR_MAX_QUEUED_REVIEW_AGE_MS;
}

export function claimAdvisorRun(runtime, label = "advisor-run") {
  const claim = { generation: runtime.generation, token: Symbol(label) };
  runtime.running = true;
  runtime.activeRunToken = claim.token;
  return claim;
}

export function ownsAdvisorRun(runtime, claim) {
  return runtime.generation === claim.generation && runtime.activeRunToken === claim.token;
}

export function invalidateAdvisorRuntime(runtime) {
  runtime.generation += 1;
  runtime.activeRunToken = undefined;
  runtime.running = false;
}

export function queueLatestAdvisorReview(runtime, review) {
  const replaced = runtime.queued !== undefined;
  runtime.queued = review;
  if (replaced) runtime.droppedReviews = (runtime.droppedReviews ?? 0) + 1;
  return { replaced };
}

export function takeQueuedAdvisorReview(runtime, now = Date.now()) {
  const review = runtime.queued;
  runtime.queued = undefined;
  if (review === undefined) return { review: undefined, expired: false };
  if (!isQueuedReviewExpired(review, now)) return { review, expired: false };
  runtime.droppedReviews = (runtime.droppedReviews ?? 0) + 1;
  return { review: undefined, expired: true };
}

export function classifyAdvisorFailure(error) {
  const status = finiteStatus(error);
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (error instanceof AdvisorLifecycleAbortedError) return "aborted";
  if (/^Advisor response quarantined:/i.test(message)) return "quarantined";
  if (
    status === 429 ||
    /quota|usage limit|rate.?limit|resource.?exhausted|insufficient_quota|credit balance/i.test(message)
  ) return "quota";
  if (/context.{0,20}(?:length|window|overflow)|maximum context|too many tokens/i.test(message)) {
    return "context";
  }
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    /invalid_request_error|authentication|authorization|unauthorized|forbidden|permission denied|invalid api key|model[_ ]not[_ ]found|model.{0,30}(?:not supported|does not exist)|unsupported model/i.test(message)
  ) return "permanent";
  return "transient";
}

export function shouldResetAdvisorContext({ messages, incomingText, model, systemPrompt = "", tools = [] }) {
  const contextWindow = finitePositive(model?.contextWindow);
  if (contextWindow === null) return false;
  const maxOutput = finitePositive(model?.maxTokens) ?? 0;
  const reserve = Math.max(ADVISOR_CONTEXT_RESERVE_TOKENS, maxOutput);
  const usableWindow = Math.max(1, contextWindow - reserve);
  const localMessageTokens = estimateMessageTokens(messages);
  const providerContextTokens = latestProviderContextTokens(messages);
  const fixedTokens = Math.ceil((String(systemPrompt).length + safeJsonLength(tools)) / 4);
  const currentTokens = Math.max(providerContextTokens, fixedTokens + localMessageTokens);
  const incomingTokens = Math.ceil(String(incomingText ?? "").length / 4);
  return currentTokens + incomingTokens > usableWindow;
}

export function admitAdvisorCandidate({
  candidate,
  guard,
  expectedTurnIdentity,
  expectedGeneration,
  expectedEpoch,
  stale = false,
}) {
  if (candidate?.epoch !== expectedEpoch) return { accepted: false, reason: "stale-epoch" };
  if (candidate?.generation !== expectedGeneration) {
    return { accepted: false, reason: "stale-generation" };
  }
  if (candidate?.turnIdentity !== expectedTurnIdentity) {
    return { accepted: false, reason: "stale-turn" };
  }
  if (!candidate || typeof candidate.note !== "string") {
    return { accepted: false, reason: "invalid-note" };
  }
  if (candidate.severity !== "nit" && candidate.severity !== "concern" && candidate.severity !== "blocker") {
    return { accepted: false, reason: "invalid-severity" };
  }
  const note = candidate.note.trim();
  if (note.length === 0 || note.length > ADVISOR_MAX_ADVICE_CHARS || note.includes("\0")) {
    return { accepted: false, reason: "invalid-note" };
  }
  if (!guard.accept(note, candidate.severity)) {
    return { accepted: false, reason: "suppressed" };
  }
  const annotated = stale && note.length + STALE_ADVICE_SUFFIX.length <= ADVISOR_MAX_ADVICE_CHARS
    ? `${note}${STALE_ADVICE_SUFFIX}`
    : note;
  return {
    accepted: true,
    candidate: { note: annotated, severity: candidate.severity },
  };
}

export function retryDelayMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) return 0;
  return Math.min(2_000, 250 * 2 ** (attempt - 1));
}

export async function runBoundedAdvisorAttempts({
  attempt,
  onContextReset = async () => {},
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  maxAttempts = ADVISOR_MAX_REVIEW_ATTEMPTS,
}) {
  if (typeof attempt !== "function") throw new TypeError("attempt must be a function");
  const boundedAttempts = Number.isInteger(maxAttempts) && maxAttempts > 0
    ? maxAttempts
    : ADVISOR_MAX_REVIEW_ATTEMPTS;
  let lastError;
  let contextResetPerformed = false;
  for (let attemptNumber = 1; attemptNumber <= boundedAttempts; attemptNumber += 1) {
    try {
      return { ok: true, value: await attempt(attemptNumber), attempts: attemptNumber };
    } catch (error) {
      lastError = error;
      const failure = classifyAdvisorFailure(error);
      if (
        failure === "aborted" ||
        failure === "quarantined" ||
        failure === "quota" ||
        failure === "permanent"
      ) {
        return { ok: false, failure, error, attempts: attemptNumber };
      }
      if (failure === "context" && attemptNumber < boundedAttempts) {
        if (contextResetPerformed) {
          return { ok: false, failure: "context", error, attempts: attemptNumber };
        }
        const resetAccepted = await onContextReset(error, attemptNumber);
        if (resetAccepted === false) {
          return { ok: false, failure: "context", error, attempts: attemptNumber };
        }
        contextResetPerformed = true;
        continue;
      }
      if (attemptNumber < boundedAttempts) {
        await sleep(retryDelayMs(attemptNumber));
        continue;
      }
      return {
        ok: false,
        failure: failure === "context" ? "context" : "persistent",
        error,
        attempts: attemptNumber,
      };
    }
  }
  return { ok: false, failure: "persistent", error: lastError, attempts: boundedAttempts };
}

function findHazardMatches(hazard, text) {
  if (hazard.destructiveShell === true) {
    const candidates = text.match(/\brm\s+(?:-[a-z]+\s*)+(?:--\s+)?[^\s;&|`]+/gi) ?? [];
    return candidates.filter((candidate) => {
      const optionText = candidate
        .slice(0, candidate.lastIndexOf(" "))
        .split(/\s+/u)
        .filter((part) => part.startsWith("-"))
        .join("");
      return optionText.includes("r") && optionText.includes("f");
    });
  }
  if (!(hazard.pattern instanceof RegExp)) return [];
  const flags = hazard.pattern.flags.includes("g") ? hazard.pattern.flags : `${hazard.pattern.flags}g`;
  return [...text.matchAll(new RegExp(hazard.pattern.source, flags))].map((match) => match[0]);
}

function normalizeHazardProvenance(value) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

function finiteStatus(error) {
  if (!error || typeof error !== "object") return null;
  for (const key of ["status", "statusCode", "code"]) {
    const value = error[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  }
  return null;
}

function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function latestProviderContextTokens(messages) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || !message.usage) continue;
    const usage = message.usage;
    const total = finitePositive(usage.totalTokens) ??
      [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
        .reduce((sum, value) => sum + (finitePositive(value) ?? 0), 0);
    if (total > 0) return total + estimateMessageTokens(messages.slice(index + 1));
  }
  return 0;
}

function safeJsonLength(value) {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return 1_024;
  }
}

function estimateMessageTokens(messages) {
  let chars = 0;
  for (const message of messages ?? []) {
    if (typeof message?.content === "string") {
      chars += message.content.length;
      continue;
    }
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (typeof block?.text === "string") chars += block.text.length;
      if (typeof block?.thinking === "string") chars += block.thinking.length;
      if (block?.type === "toolCall") {
        chars += String(block.name ?? "").length;
        try {
          chars += JSON.stringify(block.arguments ?? null).length;
        } catch {
          chars += 256;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}
