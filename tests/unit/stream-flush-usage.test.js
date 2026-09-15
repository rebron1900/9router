import { describe, expect, it } from "vitest";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function sse(frames) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

function dataEvents(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()))
    .filter((parsed) => typeof parsed === "object" && parsed !== null);
}

// OpenAI upstream → Claude client: targetFormat is the PROVIDER format,
// sourceFormat is the CLIENT format (see createSSEStream docs).
function claudeFromOpenAI(frames, body) {
  return drain(
    sse(frames).pipeThrough(
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "test-provider", null, null, "test-model", null, body, null, null),
    ),
  );
}

function antigravityFromOpenAI(frames, body) {
  return drain(
    sse(frames).pipeThrough(
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, "test-provider", null, null, "test-model", null, body, null, null),
    ),
  );
}

function responsesFromOpenAI(frames, body) {
  return drain(
    sse(frames).pipeThrough(
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "test-provider", null, null, "test-model", null, body, null, null),
    ),
  );
}

describe("SSE terminal usage injection (transform + flush)", () => {
  it("injects estimated usage when a deferred finish never receives a usage trailer", async () => {
    const body = { messages: [{ role: "user", content: "hello".repeat(100) }], model: "test-model" };
    const text = await claudeFromOpenAI([
      'data: {"id":"chatcmpl-flush","choices":[{"index":0,"delta":{"role":"assistant","content":"a reasonably long streamed answer"}}]}\n\n',
      // Finish carries NO usage and no trailer ever arrives: the Claude
      // terminal is deferred to flush(). Flush must run the same usage
      // estimation as the transform loop instead of emitting zeros.
      'data: {"id":"chatcmpl-flush","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ], body);

    const messageDelta = dataEvents(text).find((event) => event.type === "message_delta");
    expect(messageDelta).toBeDefined();
    expect(messageDelta.usage).toBeDefined();
    expect(messageDelta.usage.input_tokens).toBeGreaterThan(0);
    expect(messageDelta.usage.output_tokens).toBeGreaterThan(0);
    expect(messageDelta.usage.estimated).toBe(true);
  });

  it("buffers real usage into the flush terminal when a delayed trailer arrived", async () => {
    const body = { messages: [{ role: "user", content: "hello".repeat(100) }], model: "test-model" };
    const text = await claudeFromOpenAI([
      'data: {"id":"chatcmpl-delayed","choices":[{"index":0,"delta":{"role":"assistant","content":"answer"}}]}\n\n',
      'data: {"id":"chatcmpl-delayed","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      // Authoritative usage-only trailer AFTER the finish chunk.
      'data: {"id":"chatcmpl-delayed","choices":[],"usage":{"prompt_tokens":500,"completion_tokens":20,"input_tokens_details":{"cached_tokens":480}}}\n\n',
      "data: [DONE]\n\n",
    ], body);

    const messageDelta = dataEvents(text).find((event) => event.type === "message_delta");
    expect(messageDelta).toBeDefined();
    expect(messageDelta.usage.estimated).toBeUndefined();
    expect(messageDelta.usage.input_tokens).toBe(20);
    expect(messageDelta.usage.output_tokens).toBe(20);
    expect(messageDelta.usage.cache_read_input_tokens).toBe(480);
  });

  it("injects estimated usage into an Antigravity response envelope", async () => {
    const body = { messages: [{ role: "user", content: "hello".repeat(100) }], model: "test-model" };
    const text = await antigravityFromOpenAI([
      'data: {"id":"chatcmpl-ag","choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n',
      'data: {"id":"chatcmpl-ag","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ], body);

    const response = dataEvents(text).find((event) => event.response?.usageMetadata);
    expect(response?.response?.usageMetadata?.promptTokenCount).toBeGreaterThan(0);
    expect(response?.response?.usageMetadata?.candidatesTokenCount).toBeGreaterThan(0);
    expect(response?.response?.usageMetadata?.estimated).toBe(true);
  });

  it("injects estimated usage into a Responses completed envelope", async () => {
    const body = { messages: [{ role: "user", content: "hello".repeat(100) }], model: "test-model" };
    const text = await responsesFromOpenAI([
      'data: {"id":"chatcmpl-resp","choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n',
      'data: {"id":"chatcmpl-resp","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ], body);

    const completed = dataEvents(text).find((event) => event.type === "response.completed");
    expect(completed?.response?.usage?.input_tokens).toBeGreaterThan(0);
    expect(completed?.response?.usage?.output_tokens).toBeGreaterThan(0);
    expect(completed?.response?.usage?.estimated).toBe(true);
  });
});
