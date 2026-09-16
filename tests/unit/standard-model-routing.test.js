import { describe, it, expect, beforeEach, vi } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { planStandardModelCandidates } from "../../src/lib/standardModels/planner.js";
import {
  buildStandardRouteErrorResponse,
  classifyStandardRouteFailure,
  createStandardRouteBudget,
  cleanupStandardResponseAffinities,
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
  STANDARD_RESPONSE_AFFINITY_MAX_ENTRIES,
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
    expect(classifyStandardRouteFailure({ status: 520, error: "Invalid error response format: Gateway request failed" })).toMatchObject({
      category: "transport",
      shouldFallback: true,
      retryable: true,
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

  it("purges expired affinities and bounds the in-memory table", () => {
    const now = () => 200000;
    for (let i = 0; i < STANDARD_RESPONSE_AFFINITY_MAX_ENTRIES + 1; i++) {
      expect(recordStandardResponseAffinity(`resp-cap-${i}`, {
        standardModelId: "standard-1",
        providerId: "provider-a",
        upstreamModelId: "model-a",
      }, now)).toBe(true);
    }

    // Insertion order is the eviction order, so the oldest entry is removed.
    expect(getStandardResponseAffinity("resp-cap-0", now)).toBeNull();
    expect(getStandardResponseAffinity(`resp-cap-${STANDARD_RESPONSE_AFFINITY_MAX_ENTRIES}`, now)).not.toBeNull();
    expect(cleanupStandardResponseAffinities(() => now() + 30 * 60 * 1000 + 1)).toBe(0);
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

  it("commits the route budget on the first streamed output", async () => {
    vi.useFakeTimers();
    const budget = createStandardRouteBudget({ maxAttempts: 2, timeoutMs: 100 });
    const streamController = createStreamController({
      externalSignal: budget.signal,
      provider: "provider-a",
      model: "model-a",
      log: {},
    });
    const onRouteCommit = vi.fn(() => budget.commit());
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"hello"}}]}\n\n`));
        controller.close();
      },
    });

    try {
      const result = await handleStreamingResponse({
        providerResponse: new Response(upstreamBody, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
        provider: "provider-a",
        model: "model-a",
        sourceFormat: FORMATS.OPENAI,
        targetFormat: FORMATS.OPENAI,
        body: { stream: true },
        stream: true,
        requestStartTime: Date.now(),
        streamController,
        attemptBudget: budget,
        preflightStream: true,
        onRouteCommit,
      });
      const reader = result.response.body.getReader();
      await reader.read();
      expect(onRouteCommit).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(101);
      expect(budget.signal.aborted).toBe(false);
      await reader.cancel();
    } finally {
      budget.dispose();
      vi.useRealTimers();
    }
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

  it("falls back on an upstream socket reset when no client abort signal exists", async () => {
    const tried = [];
    const response = await handleComboChat({
      body: { stream: false },
      models: ["provider-a/model-a", "provider-b/model-b"],
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        if (model.startsWith("provider-a/")) {
          return new Response(JSON.stringify({ error: { message: "fetch failed (UND_ERR_SOCKET)" } }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      log,
      comboName: "standard:socket-reset",
      comboStrategy: "fallback",
      autoSwitch: false,
      failureClassifier: ({ status, errorText }) => ({
        ...classifyStandardRouteFailure({ status, error: errorText }),
        cooldownMs: 0,
      }),
    });

    expect(tried).toEqual(["provider-a/model-a", "provider-b/model-b"]);
    expect(response.status).toBe(200);
  });

  it("does not report a committed deferred heartbeat as provider success", async () => {
    const onAttemptResult = vi.fn();
    let settleDeferred;
    const deferred = new Promise((resolve) => { settleDeferred = resolve; });
    const provisional = new Response("\n{}", { status: 200 });
    Object.defineProperty(provisional, "__9routerDeferredOutcome", {
      value: deferred,
    });

    const response = await handleComboChat({
      body: { stream: false },
      models: ["provider-a/model-a"],
      handleSingleModel: async () => provisional,
      log,
      comboName: "standard:deferred",
      comboStrategy: "fallback",
      autoSwitch: false,
      failureClassifier: ({ status, errorText }) => ({
        ...classifyStandardRouteFailure({ status, error: errorText }),
        cooldownMs: 0,
      }),
      onAttemptResult,
    });

    expect(response).toBe(provisional);
    expect(onAttemptResult).not.toHaveBeenCalled();
    settleDeferred({ success: false, status: 503, error: "provider overloaded" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onAttemptResult).toHaveBeenCalledOnce();
    expect(onAttemptResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false, deferred: true, status: 503 }));
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

  it("filters capability conflicts per mapping while keeping compatible mappings on the same binding", () => {
    const plan = planStandardModelCandidates({
      model: { id: "standard-vision", publicName: "vision", requiredCapabilities: { vision: true } },
      bindings: [{
        id: "binding-a",
        providerId: "provider-a",
        mappings: [
          { id: "text", upstreamModelId: "text-only", capabilityOverrides: { vision: false } },
          { id: "vision", upstreamModelId: "vision-model", capabilityOverrides: { vision: true } },
        ],
      }],
    });

    expect(plan.candidates.map((candidate) => candidate.upstreamModelId)).toEqual(["vision-model"]);
    expect(plan.candidates[0].capabilityOverrides).toEqual({ vision: true });
  });

  it("reports capability mismatch when every mapping conflicts", () => {
    const plan = planStandardModelCandidates({
      model: { id: "standard-vision", requiredCapabilities: { vision: true } },
      bindings: [{
        id: "binding-a",
        providerId: "provider-a",
        mappings: [{ upstreamModelId: "text-only", capabilityOverrides: { vision: false } }],
      }],
    });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.excluded).toEqual([{ providerId: "provider-a", reason: "capability_mismatch" }]);
  });

  it("selects the explicit generation and edit mappings for unified image requests", () => {
    const bindings = [{
      id: "binding-images",
      providerId: "openai",
      priority: 1,
      configured: true,
      mappings: [
        {
          id: "generation",
          upstreamModelId: "gpt-image-1",
          mappingPriority: 1,
          requestFormats: ["openai-images"],
          operations: ["image_generation"],
        },
        {
          id: "edit",
          upstreamModelId: "gpt-image-1",
          mappingPriority: 2,
          requestFormats: ["openai"],
          operations: ["image_edit"],
        },
        {
          id: "chat-only",
          upstreamModelId: "gpt-4o",
          mappingPriority: 3,
          requestFormats: ["openai-chat"],
          operations: ["chat"],
        },
      ],
    }];

    const generation = planStandardModelCandidates({
      model: { id: "standard-image", publicName: "unified-image", enabled: true },
      bindings,
      requestFormat: ["openai-images", "openai-image", "openai"],
      operation: ["image_generation", "images.generate", "generation"],
      requireConfiguredProvider: true,
    });
    const edit = planStandardModelCandidates({
      model: { id: "standard-image", publicName: "unified-image", enabled: true },
      bindings,
      requestFormat: ["openai-images", "openai-image", "openai"],
      operation: ["image_edit", "images.edit", "edit"],
      requireConfiguredProvider: true,
    });

    expect(generation.candidates.map((candidate) => candidate.mappingId)).toEqual(["generation"]);
    expect(edit.candidates.map((candidate) => candidate.mappingId)).toEqual(["edit"]);
  });
});
