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

  it("keeps the deadline alive after the first response chunk", async () => {
    vi.useFakeTimers();
    const budget = createStandardRouteBudget({ maxAttempts: 2, timeoutMs: 100 });
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
      expect(budget.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(101);
      expect(budget.signal.aborted).toBe(true);
      await expect(reader.read()).rejects.toMatchObject({ code: "STANDARD_ROUTE_BUDGET_EXHAUSTED" });
    } finally {
      try { await reader.cancel(); } catch { /* stream already errored */ }
      budget.dispose();
      vi.useRealTimers();
    }
  });
});
