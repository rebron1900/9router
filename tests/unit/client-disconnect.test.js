import { describe, it, expect } from "vitest";
import { isClientDisconnect } from "open-sse/utils/error.js";
import { checkFallbackError } from "open-sse/services/accountFallback.js";
import { classifyStandardRouteFailure } from "@/lib/standardModels/runtime.js";

/** An error with a given `name` and (usually) no message. */
const named = (name, message = "") => Object.assign(new Error(message), { name });

describe("isClientDisconnect — the caller went away", () => {
  it("recognises ResponseAborted, whose message is EMPTY", () => {
    // This is the whole reason matching on the error text is not enough: the
    // error Next.js throws when the client tears the response down carries no
    // message at all, so only the `name` identifies it.
    const err = named("ResponseAborted");
    expect(err.message).toBe("");
    expect(isClientDisconnect(err)).toBe(true);
  });

  it("recognises AbortError", () => {
    expect(isClientDisconnect(named("AbortError"))).toBe(true);
  });

  it("recognises transport-level disconnect codes", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE", "UND_ERR_SOCKET"]) {
      expect(isClientDisconnect(Object.assign(new Error("x"), { code }))).toBe(true);
    }
  });

  it("recognises disconnect wording", () => {
    expect(isClientDisconnect(new Error("socket hang up"))).toBe(true);
    expect(isClientDisconnect(new Error("Request aborted by client"))).toBe(true);
    expect(isClientDisconnect("client disconnect")).toBe(true);
  });

  it("looks through a nested cause", () => {
    const err = new Error("fetch failed");
    err.cause = named("ResponseAborted");
    expect(isClientDisconnect(err)).toBe(true);
  });

  it("does not treat real provider failures as disconnects", () => {
    // A genuine upstream problem must keep surfacing as an error — otherwise
    // this fix would silence the very failures the fallback exists for.
    for (const message of [
      "capacity exceeded", "overloaded", "rate limit reached",
      "quota exceeded", "no credentials", "model not found", "improperly formed request",
    ]) {
      expect(isClientDisconnect(new Error(message))).toBe(false);
    }
    expect(isClientDisconnect(Object.assign(new Error("boom"), { code: "ETIMEDOUT" }))).toBe(false);
    expect(isClientDisconnect(undefined)).toBe(false);
    expect(isClientDisconnect(null)).toBe(false);
  });
});

describe("checkFallbackError — a cancelled request must not burn an account", () => {
  it("499 short-circuits before the unmatched-error default cooldown", () => {
    // Regression: 499 matches no rule in ERROR_RULES, so it used to fall through
    // to the built-in TRANSIENT_COOLDOWN_MS (30s) and lock the account, which
    // then rejected every following retry with 503.
    const result = checkFallbackError(499, "Request aborted", 0);
    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(0);
  });

  it("still cools down for genuine upstream failures", () => {
    expect(checkFallbackError(401, "unauthorized", 0).shouldFallback).toBe(true);
    expect(checkFallbackError(429, "rate limit", 0).shouldFallback).toBe(true);
    expect(checkFallbackError(429, "rate limit", 0).cooldownMs).toBeGreaterThan(0);
    expect(checkFallbackError(500, "internal error", 0).shouldFallback).toBe(true);
    expect(checkFallbackError(0, "capacity exceeded", 0).cooldownMs).toBeGreaterThan(0);
  });
});

describe("classifyStandardRouteFailure — cancellation is not a health signal", () => {
  it("classifies 499 as cancelled and ineligible for health/fallback", () => {
    const c = classifyStandardRouteFailure({ status: 499, error: "Request aborted" });
    expect(c.category).toBe("cancelled");
    expect(c.shouldFallback).toBe(false);
    expect(c.healthEligible).toBe(false);
    expect(c.retryable).toBe(false);
  });

  it("classifies a bare ResponseAborted string as cancelled", () => {
    // The rewritten preflight message drops the word "aborted"; the error NAME
    // is what has to carry the signal through.
    const c = classifyStandardRouteFailure({ status: 502, error: "ResponseAborted" });
    expect(c.category).toBe("cancelled");
    expect(c.healthEligible).toBe(false);
  });

  it("still treats a real overload as retryable", () => {
    const c = classifyStandardRouteFailure({ status: 503, error: "capacity exceeded" });
    expect(c.category).not.toBe("cancelled");
  });
});
