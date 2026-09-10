import { describe, it, expect, beforeEach, vi } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { planStandardModelCandidates } from "../../src/lib/standardModels/planner.js";
import {
  buildStandardRouteErrorResponse,
  classifyStandardRouteFailure,
  createStandardRouteBudget,
  extractStandardResponseIdFromChunk,
  getStandardResponseAffinity,
  getStandardProviderHealth,
  getStandardProviderHealthKey,
  isStandardProviderCoolingDown,
  recordStandardResponseAffinity,
  recordStandardProviderFailure,
  recordStandardProviderSuccess,
  resetStandardResponseAffinities,
  resetStandardProviderHealth,
} from "../../src/lib/standardModels/runtime.js";

const log = {
  info() {},
  warn() {},
};

describe("standard model route runtime", () => {
  beforeEach(() => {
    resetStandardProviderHealth();
    resetStandardResponseAffinities();
  });

  it("does not retry malformed requests against another provider", () => {
    const failure = classifyStandardRouteFailure({
      status: 400,
      error: "invalid request: malformed tool definition",
    });

    expect(failure).toMatchObject({
      category: "request",
      retryable: false,
      shouldFallback: false,
    });
  });

  it("classifies capacity and transport failures as provider fallback candidates", () => {
    expect(classifyStandardRouteFailure({ status: 429, error: "rate limit exceeded" })).toMatchObject({
      category: "capacity",
      shouldFallback: true,
      healthEligible: true,
    });
    expect(classifyStandardRouteFailure({ status: 503, error: "upstream connection timeout" })).toMatchObject({
      category: "transport",
      shouldFallback: true,
      healthEligible: true,
    });
  });

  it("enforces a shared attempt budget and request cancellation", () => {
    const controller = new AbortController();
    const budget = createStandardRouteBudget({ maxAttempts: 2, signal: controller.signal });

    expect(budget.consume({ provider: "one" }).allowed).toBe(true);
    expect(budget.consume({ provider: "two" }).allowed).toBe(true);
    expect(budget.consume({ provider: "three" }).allowed).toBe(false);

    controller.abort();
    expect(budget.canAttempt()).toBe(false);
    expect(budget.snapshot()).toMatchObject({ attempts: 2, aborted: true, remainingAttempts: 0 });
  });

  it("propagates request cancellation to the upstream stream signal", () => {
    const controller = new AbortController();
    const stream = createStreamController({
      externalSignal: controller.signal,
      provider: "provider-a",
      model: "model-a",
      log: {},
    });

    expect(stream.signal.aborted).toBe(false);
    controller.abort();
    expect(stream.signal.aborted).toBe(true);
    stream.abort();
  });

  it("backs off unhealthy provider mappings and clears them after success", () => {
    const key = getStandardProviderHealthKey("standard-1", "provider-a", "upstream-model");
    const now = () => 100000;
    const state = recordStandardProviderFailure(key, { category: "capacity", status: 429, now });

    expect(state).toMatchObject({ consecutiveFailures: 1, category: "capacity", status: 429 });
    expect(isStandardProviderCoolingDown(key, now)).toBe(true);
    expect(getStandardProviderHealth(key, now)?.remainingMs).toBeGreaterThan(0);

    recordStandardProviderSuccess(key);
    expect(isStandardProviderCoolingDown(key, now)).toBe(false);
  });

  it("records response affinity with the selected provider account and expires it", () => {
    const now = () => 100000;
    expect(recordStandardResponseAffinity("resp_1", {
      standardModelId: "standard-1",
      providerId: "provider-a",
      upstreamModelId: "model-a",
      connectionId: "account-a",
    }, now)).toBe(true);

    expect(getStandardResponseAffinity("resp_1", now)).toMatchObject({
      standardModelId: "standard-1",
      providerId: "provider-a",
      upstreamModelId: "model-a",
      connectionId: "account-a",
    });
    expect(getStandardResponseAffinity("resp_1", () => 100000 + 30 * 60 * 1000 + 1)).toBeNull();
  });

  it("extracts a Responses response ID from an SSE data chunk", () => {
    const chunk = new TextEncoder().encode(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_42"}}\n\n'
    );
    expect(extractStandardResponseIdFromChunk(chunk)).toBe("resp_42");
  });

  it("rejects an upstream SSE failure before the first output chunk", async () => {
    const onRequestSuccess = vi.fn();
    const handleError = vi.fn();
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("event: response."));
        controller.enqueue(encoder.encode("failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"provider overloaded\"}}}\n\n"));
        controller.close();
      },
    });
    const result = await handleStreamingResponse({
      providerResponse: new Response(upstreamBody, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      preflightStream: true,
      onRequestSuccess,
      streamController: { handleError },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(handleError).toHaveBeenCalledOnce();
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("falls back on a non-stream provider failure and returns the successful response", async () => {
    const tried = [];
    const response = await handleComboChat({
      body: { stream: false },
      models: ["provider-a/model-a", "provider-b/model-b"],
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        if (model.startsWith("provider-a/")) {
          return new Response(JSON.stringify({ error: { message: "capacity exhausted" } }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true, provider: model }), { status: 200 });
      },
      log,
      comboName: "standard:test",
      comboStrategy: "fallback",
      autoSwitch: false,
      failureClassifier: ({ status, errorText }) => ({
        ...classifyStandardRouteFailure({ status, error: errorText }),
        cooldownMs: 0,
      }),
    });

    expect(tried).toEqual(["provider-a/model-a", "provider-b/model-b"]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, provider: "provider-b/model-b" });
  });

  it("returns structured route failures when all candidates fail", async () => {
    const response = buildStandardRouteErrorResponse({
      status: 503,
      publicModel: "gpt-5.6-luna",
      code: "provider_unavailable",
      failures: [{ provider: "provider-a", model: "provider-a/model-a", status: 503, category: "transport", message: "timeout" }],
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toMatchObject({
      type: "standard_model_route_error",
      code: "provider_unavailable",
      model: "gpt-5.6-luna",
    });
    expect(body.error.attempts).toHaveLength(1);
  });

  it("keeps multiple local model mappings under one provider in fallback order", () => {
    const plan = planStandardModelCandidates({
      model: { id: "standard-1", publicName: "gpt-5.6-luna", enabled: true },
      bindings: [{
        id: "binding-a",
        providerId: "commandcode",
        priority: 1,
        mappings: [
          { id: "mapping-a1", upstreamModelId: "luna", mappingPriority: 1 },
          { id: "mapping-a2", upstreamModelId: "luna-thinking", mappingPriority: 2 },
        ],
      }],
    });

    expect(plan.candidates.map((candidate) => candidate.upstreamModelId)).toEqual([
      "luna",
      "luna-thinking",
    ]);
  });
});
