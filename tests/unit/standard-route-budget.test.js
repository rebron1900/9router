import http from "node:http";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { createStandardRouteBudget } = await import("../../src/lib/standardModels/runtime.js");
const { withStandardRouteBudgetResponse } = await import("../../src/sse/handlers/chat.js");

let server;
let baseUrl;
const openSockets = new Set();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/hang") return;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  for (const socket of openSockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
});

function upstreamResponse(status) {
  return { status, headers: { get: () => "" } };
}

describe("standard route budget at the executor boundary", () => {
  beforeEach(() => fetchMock.mockReset());

  it("consumes an attempt for every real fetch, including a status retry", async () => {
    fetchMock.mockResolvedValue(upstreamResponse(502));
    const executor = new BaseExecutor("test", {
      baseUrl: "https://provider.test/v1",
      retry: { 502: { attempts: 2, delayMs: 0 } },
    });
    const budget = createStandardRouteBudget({ maxAttempts: 1, timeoutMs: 30_000 });

    await expect(executor.execute({
      model: "model",
      body: {},
      stream: false,
      credentials: { apiKey: "test" },
      attemptBudget: budget,
    })).rejects.toMatchObject({ code: "STANDARD_ROUTE_BUDGET_EXHAUSTED" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(budget.snapshot()).toMatchObject({ attempts: 1, remainingAttempts: 0 });
    budget.dispose();
  });

  it("aborts a retry wait when the shared route deadline expires", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(upstreamResponse(502));
      const executor = new BaseExecutor("test", {
        baseUrl: "https://provider.test/v1",
        retry: { 502: { attempts: 2, delayMs: 1_000 } },
      });
      const budget = createStandardRouteBudget({ maxAttempts: 3, timeoutMs: 100 });
      const execution = executor.execute({
        model: "model",
        body: {},
        stream: false,
        credentials: { apiKey: "test" },
        attemptBudget: budget,
      });
      const rejected = expect(execution).rejects.toMatchObject({ code: "STANDARD_ROUTE_BUDGET_EXHAUSTED" });

      // Let the immediate mocked fetch settle and enter BaseExecutor's
      // abortable retry wait before advancing the shared deadline.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(fetchMock).toHaveBeenCalledOnce();
      budget.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts and aborts real proxyAwareFetch attempts at the proxy boundary", async () => {
    const { proxyAwareFetch } = await vi.importActual("../../open-sse/utils/proxyFetch.js");
    const budget = createStandardRouteBudget({ maxAttempts: 2, timeoutMs: 5_000 });
    try {
      const first = await proxyAwareFetch(`${baseUrl}/ok`, {}, {
        attemptBudget: budget,
        attemptProvider: "proxy-test",
        attemptModel: "model",
      });
      expect(first.status).toBe(200);
      const second = await proxyAwareFetch(`${baseUrl}/ok`, {}, {
        attemptBudget: budget,
        attemptProvider: "proxy-test",
        attemptModel: "model",
      });
      expect(second.status).toBe(200);
      expect(budget.snapshot()).toMatchObject({ attempts: 2, remainingAttempts: 0 });
      await expect(proxyAwareFetch(`${baseUrl}/ok`, {}, { attemptBudget: budget }))
        .rejects.toMatchObject({ code: "STANDARD_ROUTE_BUDGET_EXHAUSTED" });
    } finally {
      budget.dispose();
    }

    const timeoutBudget = createStandardRouteBudget({ maxAttempts: 2, timeoutMs: 40 });
    try {
      await expect(proxyAwareFetch(`${baseUrl}/hang`, {}, {
        attemptBudget: timeoutBudget,
        attemptProvider: "proxy-test",
        attemptModel: "model",
      })).rejects.toMatchObject({ code: "STANDARD_ROUTE_BUDGET_EXHAUSTED" });
      expect(timeoutBudget.snapshot().timedOut).toBe(true);
    } finally {
      timeoutBudget.dispose();
    }
  });

  it("does not return a successful Codex stream after the route budget aborts its preflight peek", async () => {
    const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
    const budget = createStandardRouteBudget({ maxAttempts: 2, timeoutMs: 30 });
    const encoder = new TextEncoder();
    fetchMock.mockImplementation(async (_url, options = {}) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_test" } })}\n\n`));
          const signal = options?.signal;
          signal?.addEventListener?.("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    try {
      const execution = new CodexExecutor().execute({
        model: "gpt-5.6-luna",
        body: { model: "gpt-5.6-luna", input: "hello", stream: true },
        stream: true,
        credentials: { apiKey: "test" },
        attemptBudget: budget,
        proxyOptions: { attemptBudget: budget },
      });
      const rejected = expect(execution).rejects.toMatchObject({ code: "STANDARD_ROUTE_BUDGET_EXHAUSTED" });
      await vi.waitFor(() => expect(budget.signal.aborted).toBe(true));
      await rejected;
    } finally {
      budget.dispose();
    }
  });

  it("keeps a custom executor budget rejection out of its generic 502 response", async () => {
    const { GrokWebExecutor } = await import("../../open-sse/executors/grok-web.js");
    const budget = createStandardRouteBudget({ maxAttempts: 1, timeoutMs: 5_000 });
    const originalFetch = globalThis.fetch;
    const budgetError = budget.error();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(budgetError));
    try {
      const executor = new GrokWebExecutor();
      await expect(executor.execute({
        model: "grok-4.1-fast",
        body: { messages: [{ role: "user", content: "hello" }] },
        stream: false,
        credentials: { apiKey: "sso=test" },
        proxyOptions: { attemptBudget: budget },
      })).rejects.toMatchObject({ code: "STANDARD_ROUTE_BUDGET_EXHAUSTED" });
    } finally {
      vi.stubGlobal("fetch", originalFetch);
      budget.dispose();
    }
  });

  it("stops the route deadline after the first committed response chunk", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const budget = createStandardRouteBudget({ maxAttempts: 2, timeoutMs: 100, signal: parent.signal });
    const encoder = new TextEncoder();
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("first"));
        budget.signal.addEventListener("abort", () => controller.error(budget.signal.reason), { once: true });
      },
    });
    const response = withStandardRouteBudgetResponse(new Response(source), budget);
    const reader = response.body.getReader();
    try {
      await expect(reader.read()).resolves.toMatchObject({ done: false });
      budget.commit();
      expect(budget.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(101);
      expect(budget.signal.aborted).toBe(false);
      expect(budget.snapshot()).toMatchObject({ committed: true, timedOut: false });
      parent.abort();
      expect(budget.signal.aborted).toBe(true);
    } finally {
      try { await reader.cancel(); } catch { /* stream already errored */ }
      budget.dispose();
      vi.useRealTimers();
    }
  });
});
