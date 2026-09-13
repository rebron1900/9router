import { describe, expect, it } from "vitest";

import { createDisconnectAwareStream, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { buildAbortedResponsesTerminalBytes } from "../../open-sse/utils/responsesStreamHelpers.js";

// Minimal stream controller stub
function makeController(clientSignal = null) {
  let connected = true;
  return {
    signal: new AbortController().signal,
    clientSignal,
    startTime: Date.now(),
    isConnected: () => connected,
    wasClientDisconnected: () => clientSignal?.aborted === true,
    handleComplete: () => { connected = false; },
    handleError: () => { connected = false; },
    handleDisconnect: () => { connected = false; },
    abort: () => { connected = false; },
  };
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

describe("Responses abort terminal synthesis", () => {
  it("emits response.failed + [DONE] when upstream errors (abort/stall)", async () => {
    // Upstream readable that errors mid-stream (simulates fetch abort on stall)
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
        controller.error(new Error("stream stall timeout"));
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      makeController(),
      buildAbortedResponsesTerminalBytes
    );

    const text = await readAll(out);
    expect(text).toContain("event: response.failed");
    expect(text).toContain("data: [DONE]");
  });

  it("does not synthesize terminal for non-Responses streams (callback null)", async () => {
    let upstreamController;
    const upstream = new ReadableStream({
      start(controller) {
        upstreamController = controller;
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      makeController(),
      null
    );

    const reader = out.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).not.toContain("response.failed");
    expect(text).not.toContain("[DONE]");
    upstreamController.error(new Error("socket hang up"));
    await expect(reader.read()).rejects.toThrow("socket hang up");
  });
});

describe("stream transport errors", () => {
  it("surfaces ETIMEDOUT from createDisconnectAwareStream", async () => {
    const timeout = Object.assign(new Error("upstream timed out"), { code: "ETIMEDOUT" });
    const upstream = new ReadableStream({ start(controller) { controller.error(timeout); } });
    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      makeController(),
      buildAbortedResponsesTerminalBytes,
    );

    await expect(readAll(out)).rejects.toMatchObject({ code: "ETIMEDOUT" });
  });

  it("keeps a client ECONNRESET as a graceful close", async () => {
    const client = new AbortController();
    client.abort();
    const reset = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const upstream = new ReadableStream({ start(controller) { controller.error(reset); } });
    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      makeController(client.signal),
    );

    await expect(readAll(out)).resolves.toBe("");
  });

  it("uses the same timeout and reset semantics through pipeWithDisconnect", async () => {
    const timeout = Object.assign(new Error("upstream timed out"), { code: "ETIMEDOUT" });
    const upstream = new ReadableStream({ start(controller) { controller.error(timeout); } });
    const out = pipeWithDisconnect(
      new Response(upstream),
      new TransformStream(),
      makeController(),
      buildAbortedResponsesTerminalBytes,
      60_000,
    );

    await expect(readAll(out)).rejects.toMatchObject({ code: "ETIMEDOUT" });
  });
});
