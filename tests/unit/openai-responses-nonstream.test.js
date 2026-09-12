import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

// A chat.completion body as returned by a chat-native upstream (e.g. op-ericding)
const CHAT_TOOL_BODY = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1700000000,
  model: "cl/claude-haiku-4-5",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }]
    },
    finish_reason: "tool_calls"
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
};

describe("non-stream Chat upstream for a Responses-API client (op-ericding bug)", () => {
  it("translates chat.completion tool_calls into Responses function_call output", () => {
    // translateNonStreamingResponse(body, targetFormat=PROVIDER format, sourceFormat=CLIENT format)
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    expect(out.object).toBe("response");
    expect(out).not.toHaveProperty("choices");
    const fc = (out.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.call_id).toBe("call_1");
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"ls\"}");
  });

  it("translates marked Chat tools into Responses custom_tool_call output", () => {
    const customBody = structuredClone(CHAT_TOOL_BODY);
    customBody.choices[0].message.tool_calls[0] = {
      id: "call_exec",
      type: "function",
      function: {
        name: "exec",
        arguments: "{\"input\":\"return await tools.shell({command: 'pwd'});\"}"
      }
    };
    const out = translateNonStreamingResponse(
      customBody,
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      new Set(["exec"])
    );
    const call = (out.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_exec",
      name: "exec",
      input: "return await tools.shell({command: 'pwd'});"
    });
    expect(out.output.some((item) => item.type === "function_call")).toBe(false);
  });

  it("keeps chat.completion text content as a Responses message item", () => {
    const body = {
      ...CHAT_TOOL_BODY,
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }]
    };
    const out = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    const msg = (out.output || []).find((o) => o.type === "message");
    expect(msg).toBeTruthy();
    expect(msg.content[0].type).toBe("output_text");
    expect(msg.content[0].text).toBe("hello");
  });

  it("leaves chat->chat untouched", () => {
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI);
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });
});

describe("forced-SSE JSON path for a Responses-API client behind a chat upstream", () => {
  const sseCtx = (sourceFormat, targetFormat) => {
    const encoder = new TextEncoder();
    const raw = [
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"shell","arguments":""}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"pwd\\"}"}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    return {
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat,
      targetFormat,
      provider: "op-test-chat",
      model: "gpt-x",
      body: { model: "gpt-x", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/responses" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    };
  };

  it("returns null immediately when the upstream is not SSE", async () => {
    vi.useFakeTimers();
    try {
      const resultPromise = handleForcedSSEToJson({
        providerResponse: new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" }
        }),
        sourceFormat: FORMATS.OPENAI,
        targetFormat: FORMATS.OPENAI,
        provider: "op-test-chat",
        model: "gpt-x",
        body: { model: "gpt-x", messages: [] },
        stream: false,
        requestStartTime: Date.now(),
        connectionId: "test-connection",
        clientRawRequest: { endpoint: "/v1/chat/completions" },
        trackDone: vi.fn(),
        appendLog: vi.fn()
      });
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(resultPromise).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a delayed forced stream alive with JSON-safe whitespace", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let upstreamController;
      const providerResponse = new Response(new ReadableStream({
        start(controller) {
          upstreamController = controller;
          controller.enqueue(encoder.encode('{"type":"start"}\n{"type":"start-step"}\n'));
        }
      }), { headers: { "content-type": "text/event-stream" } });

      const resultPromise = handleForcedSSEToJson({
        providerResponse,
        sourceFormat: FORMATS.OPENAI,
        targetFormat: FORMATS.OPENAI,
        provider: "op-test-chat",
        model: "gpt-x",
        body: { model: "gpt-x", messages: [] },
        stream: false,
        requestStartTime: Date.now(),
        connectionId: "test-connection",
        clientRawRequest: { endpoint: "/v1/chat/completions" },
        trackDone: vi.fn(),
        appendLog: vi.fn()
      });

      await vi.advanceTimersByTimeAsync(8_000);
      const result = await resultPromise;
      expect(result.success).toBe(true);

      const reader = result.response.body.getReader();
      // The graceful path flushes one whitespace byte as soon as it takes
      // over, before any heartbeat interval has elapsed.
      const immediate = await reader.read();
      expect(new TextDecoder().decode(immediate.value)).toBe("\n");

      const heartbeatRead = reader.read();
      await vi.advanceTimersByTimeAsync(5_000);
      const heartbeat = await heartbeatRead;
      expect(new TextDecoder().decode(heartbeat.value)).toBe("\n");

      upstreamController.enqueue(encoder.encode([
        'data: {"id":"chatcmpl-delayed","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"content":"done"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
        ""
      ].join("\n\n")));
      upstreamController.close();

      const finalChunk = await reader.read();
      const finalText = new TextDecoder().decode(finalChunk.value);
      expect(finalText).toContain('"done"');
      // The leading whitespace must stay invisible to a JSON client.
      const parsed = JSON.parse(
        new TextDecoder().decode(immediate.value) +
          new TextDecoder().decode(heartbeat.value) +
          finalText,
      );
      expect(parsed.object).toBe("chat.completion");
      await expect(reader.read()).resolves.toMatchObject({ done: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a delayed SSE error after the 200 heartbeat and reports deferred failure", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let upstreamController;
      const resultPromise = handleForcedSSEToJson({
        providerResponse: new Response(new ReadableStream({ start(controller) { upstreamController = controller; } }), {
          headers: { "content-type": "text/event-stream" },
        }),
        sourceFormat: FORMATS.OPENAI,
        targetFormat: FORMATS.OPENAI,
        provider: "op-test-chat",
        model: "gpt-x",
        body: { model: "gpt-x", messages: [] },
        stream: false,
        requestStartTime: Date.now(),
        connectionId: "test-connection",
        clientRawRequest: { endpoint: "/v1/chat/completions" },
        trackDone: vi.fn(),
        appendLog: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(8_000);
      const result = await resultPromise;
      expect(result.deferred).toBe(true);
      upstreamController.enqueue(encoder.encode([
        'data: {"error":{"message":"provider overloaded","code":503}}',
        "data: [DONE]",
        "",
      ].join("\n\n")));
      upstreamController.close();

      const body = await result.response.text();
      expect(result.response.status).toBe(200);
      expect(JSON.parse(body).error.message).toContain("provider overloaded");
      await expect(result.deferredOutcome).resolves.toMatchObject({ success: false, status: 503 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a rejected buffered promise as a deferred 502 error instead of success", async () => {
    vi.useFakeTimers();
    try {
      let upstreamController;
      const resultPromise = handleForcedSSEToJson({
        providerResponse: new Response(new ReadableStream({ start(controller) { upstreamController = controller; } }), {
          headers: { "content-type": "text/event-stream" },
        }),
        sourceFormat: FORMATS.OPENAI,
        targetFormat: FORMATS.OPENAI,
        provider: "op-test-chat",
        model: "gpt-x",
        body: { model: "gpt-x", messages: [] },
        stream: false,
        requestStartTime: Date.now(),
        connectionId: "test-connection",
        clientRawRequest: { endpoint: "/v1/chat/completions" },
        trackDone: vi.fn(),
        appendLog: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(8_000);
      const result = await resultPromise;
      upstreamController.error(new Error("upstream stream rejected"));

      const body = await result.response.text();
      expect(result.response.status).toBe(200);
      expect(JSON.parse(body).error.message).toContain("Failed to convert streaming response");
      expect(JSON.parse(body).error.message).toContain("upstream stream rejected");
      await expect(result.deferredOutcome).resolves.toMatchObject({ success: false, status: 502 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses chat SSE chunks and returns a Responses function_call body", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("response");
    const fc = (json.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"pwd\"}");
  });

  it("returns a custom_tool_call for a marked tool", async () => {
    const ctx = sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
    ctx.customToolNames = new Set(["shell"]);
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    const call = (json.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_9",
      name: "shell",
      input: "{\"cmd\":\"pwd\"}"
    });
  });

  it("still returns chat.completion for a plain chat client", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });
});
