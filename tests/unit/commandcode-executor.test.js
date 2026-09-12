import { describe, it, expect, vi } from "vitest";
import {
  parseCommandCodeError,
  inspectAndWrapCommandCodeResponse,
  CommandCodeExecutor,
} from "../../open-sse/executors/commandcode.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

function createNdjsonStream(lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(typeof line === "string" ? line : JSON.stringify(line) + "\n"));
      }
      controller.close();
    },
  });
}

describe("parseCommandCodeError", () => {
  it("parses user exact error payload with statusCode 503 and isRetryable", () => {
    const event = {
      type: "error",
      error: {
        type: "server_error",
        message: "Service temporarily unavailable. Please try again shortly.",
        statusCode: 503,
        isRetryable: true,
      },
    };
    const parsed = parseCommandCodeError(event);
    expect(parsed.statusCode).toBe(503);
    expect(parsed.message).toBe("Service temporarily unavailable. Please try again shortly.");
    expect(parsed.type).toBe("server_error");
  });

  it("handles string error message", () => {
    const event = {
      type: "error",
      message: "Rate limit exceeded. Please wait 30s.",
    };
    const parsed = parseCommandCodeError(event);
    expect(parsed.statusCode).toBe(429);
    expect(parsed.message).toBe("Rate limit exceeded. Please wait 30s.");
  });

  it("handles plain error string in error property", () => {
    const event = {
      type: "error",
      error: "Unauthorized access",
    };
    const parsed = parseCommandCodeError(event);
    expect(parsed.statusCode).toBe(401);
    expect(parsed.message).toBe("Unauthorized access");
  });
});

describe("inspectAndWrapCommandCodeResponse", () => {
  it("returns after upstream headers without waiting for start/start-step or the first semantic event", async () => {
    let pullCount = 0;
    let upstreamController;
    const upstream = new ReadableStream({
      start(controller) { upstreamController = controller; },
      pull() { pullCount += 1; },
    });
    const wrapped = inspectAndWrapCommandCodeResponse(new Response(upstream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }), "poolside/laguna-s-2.1-free");

    expect(wrapped).toBeInstanceOf(Response);
    expect(wrapped.status).toBe(200);
    expect(pullCount).toBe(0);

    const reader = wrapped.body.getReader();
    upstreamController.enqueue(new TextEncoder().encode('{"type":"start"}\n{"type":"start-step"}\n'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pullCount).toBeGreaterThan(0);
    await reader.cancel();
  });

  it("converts initial upstream 200 with error event to 503 Response", async () => {
    const ndjsonBody = createNdjsonStream([
      JSON.stringify({
        type: "error",
        error: {
          type: "server_error",
          message: "Service temporarily unavailable. Please try again shortly.",
          statusCode: 503,
          isRetryable: true,
        },
      }) + "\n",
    ]);

    const fakeResponse = new Response(ndjsonBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const result = await inspectAndWrapCommandCodeResponse(fakeResponse, "poolside/laguna-s-2.1-free");
    // Body-level errors cannot change HTTP status after execute() returns the
    // upstream headers. They are emitted as an OpenAI SSE error; the forced
    // JSON aggregator turns this into a 503 before committing a client body.
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    const sse = await result.text();
    const errorLine = sse.split("\n").find((line) => line.startsWith("data: {") && line.includes('"error"'));
    expect(JSON.parse(errorLine.slice(6)).error.message).toContain("Service temporarily unavailable");
    expect(JSON.parse(errorLine.slice(6)).error.code).toBe(503);
  });

  it("converts initial upstream 200 with start/start-step followed by error to 503 Response", async () => {
    const ndjsonBody = createNdjsonStream([
      JSON.stringify({ type: "start" }) + "\n",
      JSON.stringify({ type: "start-step" }) + "\n",
      JSON.stringify({
        type: "error",
        error: {
          type: "server_error",
          message: "Service temporarily unavailable. Please try again shortly.",
          statusCode: 503,
          isRetryable: true,
        },
      }) + "\n",
    ]);

    const fakeResponse = new Response(ndjsonBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const result = await inspectAndWrapCommandCodeResponse(fakeResponse, "poolside/laguna-s-2.1-free");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    const sse = await result.text();
    const errorLine = sse.split("\n").find((line) => line.startsWith("data: {") && line.includes('"error"'));
    expect(JSON.parse(errorLine.slice(6)).error.message).toContain("Service temporarily unavailable");
  });

  it("streams successful responses when content is emitted", async () => {
    const ndjsonBody = createNdjsonStream([
      JSON.stringify({ type: "start" }) + "\n",
      JSON.stringify({ type: "text-delta", text: "Hello from Laguna" }) + "\n",
      JSON.stringify({ type: "finish" }) + "\n",
    ]);

    const fakeResponse = new Response(ndjsonBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const result = await inspectAndWrapCommandCodeResponse(fakeResponse, "poolside/laguna-s-2.1-free");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);

    const text = await result.text();
    expect(text).toContain("Hello from Laguna");
    expect(text).toContain("data: [DONE]");
  });
});

describe("CommandCode in Combo Fallback", () => {
  it("automatically falls back to next model when commandcode returns 503 error", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const handleSingleModel = vi.fn(async (body, modelStr) => {
      if (modelStr === "commandcode/poolside/laguna-s-2.1-free") {
        // Simulated failed CommandCode response
        return new Response(
          JSON.stringify({
            error: {
              message: "Service temporarily unavailable. Please try again shortly.",
              type: "server_error",
              code: 503,
            },
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }

      if (modelStr === "openai/gpt-4o-mini") {
        // Fallback model succeeds
        return new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            choices: [{ message: { role: "assistant", content: "Fallback success!" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    });

    const comboResponse = await handleComboChat({
      body: { messages: [{ role: "user", content: "Hello" }] },
      models: ["commandcode/poolside/laguna-s-2.1-free", "openai/gpt-4o-mini"],
      handleSingleModel,
      log,
      comboName: "test-combo",
      comboStrategy: "fallback",
    });

    expect(comboResponse.ok).toBe(true);
    expect(comboResponse.status).toBe(200);

    const data = await comboResponse.json();
    expect(data.choices[0].message.content).toBe("Fallback success!");
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(handleSingleModel).toHaveBeenNthCalledWith(1, expect.anything(), "commandcode/poolside/laguna-s-2.1-free");
    expect(handleSingleModel).toHaveBeenNthCalledWith(2, expect.anything(), "openai/gpt-4o-mini");
  });
});
