/**
 * Runtime primitives for standard-model routing.
 *
 * This module intentionally has no database or framework dependency. The
 * request coordinator can therefore share the same failure semantics in the
 * server and in unit tests without coupling health state to a provider.
 */

export const STANDARD_ROUTE_DEFAULTS = {
  maxGenerationAttempts: 6,
  maxRouteDurationMs: 120000,
  providerCooldownMs: 30000,
  providerCooldownMaxMs: 5 * 60 * 1000,
};

const healthState = new Map();
const responseAffinities = new Map();
const STANDARD_RESPONSE_AFFINITY_TTL_MS = 30 * 60 * 1000;
const STANDARD_RESPONSE_AFFINITY_CLEANUP_INTERVAL_MS = 60 * 1000;
export const STANDARD_RESPONSE_AFFINITY_MAX_ENTRIES = 10_000;
const STANDARD_ROUTE_BUDGET_ERROR_CODE = "STANDARD_ROUTE_BUDGET_EXHAUSTED";

function asText(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}

function lowerText(value) {
  return asText(value).toLowerCase();
}

/**
 * Classify an upstream failure from the perspective of standard routing.
 *
 * `shouldFallback` is deliberately stricter than the legacy account fallback
 * rules: malformed requests and policy failures must not be replayed against
 * another provider. The coordinator may still switch accounts for auth and
 * quota failures inside the selected provider.
 */
export function classifyStandardRouteFailure({ status, error, phase = "response" } = {}) {
  const code = Number(status) || 0;
  const text = lowerText(error);
  // Bare "ResponseAborted"/"socket closed" text is not enough to establish
  // direction: an upstream reset can carry the same wording. The chat layer
  // turns a real request-signal abort into 499 before this classifier runs.
  const cancelled = code === 499 || /request aborted|aborted by client|client disconnect|cancelled by client|canceled by client/.test(text);

  if (/standard route .*budget|attempt budget exhausted|route budget exhausted/.test(text)) {
    return {
      category: "budget",
      retryable: false,
      shouldFallback: false,
      healthEligible: false,
      phase,
    };
  }

  if (cancelled) {
    return {
      category: "cancelled",
      retryable: false,
      shouldFallback: false,
      healthEligible: false,
      phase,
    };
  }

  if (code === 400 || code === 422 || /invalid request|malformed|improperly formed|content policy|safety policy/.test(text)) {
    return {
      category: "request",
      retryable: false,
      shouldFallback: false,
      healthEligible: false,
      phase,
    };
  }

  if (code === 401 || code === 403 || /unauthori[sz]ed|authentication|invalid token|token expired|permission denied/.test(text)) {
    return {
      category: "auth",
      retryable: true,
      shouldFallback: true,
      healthEligible: true,
      phase,
    };
  }

  if (code === 404 || code === 406 || /model not found|model unavailable|unsupported model|does not support model|unknown model/.test(text)) {
    return {
      category: "unsupported_model",
      retryable: true,
      shouldFallback: true,
      healthEligible: true,
      phase,
    };
  }

  if (code === 402 || code === 429 || /rate limit|too many requests|quota|capacity|overloaded|insufficient balance/.test(text)) {
    return {
      category: "capacity",
      retryable: true,
      shouldFallback: true,
      healthEligible: true,
      phase,
    };
  }

  if (code === 502 || code === 503 || code === 504 || code === 520
    || /timeout|timed out|econn|socket|network|fetch failed|bad gateway|gateway request failed|invalid error response format|upstream gateway/.test(text)) {
    return {
      category: "transport",
      retryable: true,
      shouldFallback: true,
      healthEligible: true,
      phase,
    };
  }

  return {
    category: "unknown",
    retryable: code >= 500 || code === 0,
    shouldFallback: code >= 500 || code === 0,
    healthEligible: code >= 500 || code === 0,
    phase,
  };
}

/**
 * Create one request-scoped attempt budget shared by provider/account tries.
 * It owns the deadline AbortSignal so every fetch, retry wait, and streaming
 * response can observe the same route-wide timeout.
 */
export function createStandardRouteBudget({
  maxAttempts = STANDARD_ROUTE_DEFAULTS.maxGenerationAttempts,
  timeoutMs = STANDARD_ROUTE_DEFAULTS.maxRouteDurationMs,
  signal = null,
  now = () => Date.now(),
} = {}) {
  const limit = Number.isFinite(Number(maxAttempts)) && Number(maxAttempts) > 0
    ? Math.floor(Number(maxAttempts))
    : STANDARD_ROUTE_DEFAULTS.maxGenerationAttempts;
  const duration = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : STANDARD_ROUTE_DEFAULTS.maxRouteDurationMs;
  const startedAt = now();
  let attempts = 0;
  let lastAttempt = null;
  let timedOutByTimer = false;
  let timer = null;
  const budgetController = new AbortController();

  const budgetError = () => {
    const error = new Error("Standard route attempt budget exhausted");
    error.name = "StandardRouteBudgetExceeded";
    error.code = STANDARD_ROUTE_BUDGET_ERROR_CODE;
    error.budget = true;
    return error;
  };
  const cleanupParent = () => signal?.removeEventListener?.("abort", onParentAbort);
  const abortForBudget = () => {
    timedOutByTimer = true;
    if (!budgetController.signal.aborted) budgetController.abort(budgetError());
  };
  const onParentAbort = () => {
    if (!budgetController.signal.aborted) budgetController.abort(signal.reason);
    if (timer) { clearTimeout(timer); timer = null; }
    cleanupParent();
  };
  if (signal?.aborted) onParentAbort();
  else {
    signal?.addEventListener?.("abort", onParentAbort, { once: true });
    timer = setTimeout(abortForBudget, duration);
    timer?.unref?.();
  }

  const state = () => {
    const aborted = !!signal?.aborted || budgetController.signal.aborted;
    const elapsedMs = Math.max(0, now() - startedAt);
    const timedOut = timedOutByTimer || elapsedMs >= duration || budgetController.signal.reason?.code === STANDARD_ROUTE_BUDGET_ERROR_CODE;
    return { aborted, timedOut, elapsedMs };
  };

  return {
    canAttempt() {
      const current = state();
      return attempts < limit && !current.aborted && !current.timedOut;
    },
    consume(metadata = {}) {
      if (!this.canAttempt()) return { allowed: false, ...this.snapshot() };
      attempts += 1;
      lastAttempt = { ...metadata, number: attempts, at: now() };
      return { allowed: true, ...this.snapshot() };
    },
    snapshot() {
      const current = state();
      return {
        attempts,
        maxAttempts: limit,
        remainingAttempts: Math.max(0, limit - attempts),
        elapsedMs: current.elapsedMs,
        timeoutMs: duration,
        aborted: current.aborted,
        timedOut: current.timedOut,
        lastAttempt,
      };
    },
    get exhausted() {
      const current = state();
      return attempts >= limit || current.aborted || current.timedOut;
    },
    signal: budgetController.signal,
    error: budgetError,
    isBudgetError(error) {
      return isStandardRouteBudgetError(error);
    },
    dispose() {
      if (timer) { clearTimeout(timer); timer = null; }
      cleanupParent();
    },
  };
}

export function isStandardRouteBudgetError(error) {
  return error?.code === STANDARD_ROUTE_BUDGET_ERROR_CODE || error?.name === "StandardRouteBudgetExceeded";
}

export function getStandardProviderHealthKey(standardModelId, providerId, upstreamModelId = "") {
  return [standardModelId, providerId, upstreamModelId].map((value) => String(value || "").trim()).join("::");
}

function currentHealth(key, now = Date.now) {
  const item = healthState.get(key);
  if (!item) return null;
  const nowMs = now();
  if (!item.cooldownUntil || item.cooldownUntil <= nowMs) {
    healthState.delete(key);
    return null;
  }
  return { ...item, remainingMs: item.cooldownUntil - nowMs };
}

export function getStandardProviderHealth(key, now = Date.now) {
  return currentHealth(String(key || ""), now);
}

export function isStandardProviderCoolingDown(key, now = Date.now) {
  return !!currentHealth(String(key || ""), now);
}

export function recordStandardProviderFailure(key, {
  cooldownMs = STANDARD_ROUTE_DEFAULTS.providerCooldownMs,
  maxCooldownMs = STANDARD_ROUTE_DEFAULTS.providerCooldownMaxMs,
  category = "unknown",
  status = null,
  now = Date.now,
} = {}) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return null;
  const previous = currentHealth(normalizedKey, now);
  const consecutiveFailures = (previous?.consecutiveFailures || 0) + 1;
  const base = Math.max(1000, Number(cooldownMs) || STANDARD_ROUTE_DEFAULTS.providerCooldownMs);
  const max = Math.max(base, Number(maxCooldownMs) || STANDARD_ROUTE_DEFAULTS.providerCooldownMaxMs);
  const actualCooldownMs = Math.min(max, base * Math.pow(2, consecutiveFailures - 1));
  const item = {
    consecutiveFailures,
    category,
    status: Number(status) || null,
    cooldownMs: actualCooldownMs,
    cooldownUntil: now() + actualCooldownMs,
    updatedAt: now(),
  };
  healthState.set(normalizedKey, item);
  return { ...item, remainingMs: actualCooldownMs };
}

export function recordStandardProviderSuccess(key) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return;
  healthState.delete(normalizedKey);
}

export function getStandardProviderHealthSnapshot(now = Date.now) {
  const snapshot = {};
  for (const [key] of healthState) {
    const item = currentHealth(key, now);
    if (item) snapshot[key] = item;
  }
  return snapshot;
}

export function resetStandardProviderHealth() {
  healthState.clear();
}

function normalizeResponseId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function findResponseId(value, depth = 0) {
  if (!value || depth > 4) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = findResponseId(item, depth + 1);
      if (id) return id;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  for (const candidate of [value.id, value.response?.id, value.data?.id, value.response?.response?.id]) {
    const id = normalizeResponseId(candidate);
    if (id) return id;
  }
  return "";
}

export function extractStandardResponseId(payload) {
  if (typeof payload === "string") {
    try { return findResponseId(JSON.parse(payload)); } catch { return ""; }
  }
  return findResponseId(payload);
}

export function extractStandardResponseIdFromChunk(chunk) {
  let text = "";
  if (typeof chunk === "string") text = chunk;
  if (chunk instanceof Uint8Array || ArrayBuffer.isView(chunk)) {
    try { text = new TextDecoder().decode(chunk); } catch { return ""; }
  }
  if (text) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trimStart().startsWith("data:")) continue;
      const id = extractStandardResponseId(line.replace(/^\s*data:\s*/, "").trim());
      if (id) return id;
    }
  }
  if (text) return extractStandardResponseId(text);
  return extractStandardResponseId(chunk);
}

export function recordStandardResponseAffinity(responseId, affinity, now = Date.now) {
  const id = normalizeResponseId(responseId);
  if (!id || !affinity?.standardModelId || !affinity?.providerId || !affinity?.upstreamModelId) return false;
  const nowMs = now();
  maybePurgeExpiredResponseAffinities(nowMs);
  responseAffinities.set(id, {
    standardModelId: String(affinity.standardModelId),
    providerId: String(affinity.providerId),
    upstreamModelId: String(affinity.upstreamModelId),
    connectionId: affinity.connectionId ? String(affinity.connectionId) : null,
    expiresAt: nowMs + STANDARD_RESPONSE_AFFINITY_TTL_MS,
  });
  enforceResponseAffinityLimit();
  return true;
}

export function getStandardResponseAffinity(responseId, now = Date.now) {
  const id = normalizeResponseId(responseId);
  if (!id) return null;
  const nowMs = now();
  maybePurgeExpiredResponseAffinities(nowMs);
  const entry = responseAffinities.get(id);
  if (!entry) return null;
  // Preserve exact per-key TTL semantics even between amortized full scans.
  if (entry.expiresAt <= nowMs) {
    responseAffinities.delete(id);
    return null;
  }
  return { ...entry };
}

export function resetStandardResponseAffinities() {
  responseAffinities.clear();
  nextResponseAffinityCleanupAt = 0;
}

function purgeExpiredResponseAffinities(nowMs = Date.now()) {
  for (const [id, entry] of responseAffinities) {
    if (entry.expiresAt <= nowMs) responseAffinities.delete(id);
  }
  nextResponseAffinityCleanupAt = nowMs + STANDARD_RESPONSE_AFFINITY_CLEANUP_INTERVAL_MS;
}

let nextResponseAffinityCleanupAt = 0;

function maybePurgeExpiredResponseAffinities(nowMs) {
  if (responseAffinities.size === 0 || nowMs < nextResponseAffinityCleanupAt) return;
  purgeExpiredResponseAffinities(nowMs);
}

function enforceResponseAffinityLimit() {
  while (responseAffinities.size > STANDARD_RESPONSE_AFFINITY_MAX_ENTRIES) {
    const oldest = responseAffinities.keys().next().value;
    if (oldest === undefined) break;
    responseAffinities.delete(oldest);
  }
}

export function cleanupStandardResponseAffinities(now = Date.now) {
  purgeExpiredResponseAffinities(now());
  enforceResponseAffinityLimit();
  return responseAffinities.size;
}

export function buildStandardRouteErrorResponse({
  status = 503,
  message = "All providers for the standard model are unavailable",
  publicModel = null,
  code = "provider_unavailable",
  retryable = true,
  failures = [],
  budget = null,
} = {}) {
  const safeFailures = failures.map((failure) => ({
    provider: failure.provider || null,
    model: failure.model || null,
    status: Number(failure.status) || null,
    category: failure.category || "unknown",
    retryable: failure.retryable !== false,
    message: asText(failure.errorText || failure.message).slice(0, 240),
  }));
  const body = {
    error: {
      message,
      type: "standard_model_route_error",
      code,
      model: publicModel || undefined,
      retryable,
      attempts: safeFailures,
      budget: budget?.snapshot ? budget.snapshot() : undefined,
    },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
