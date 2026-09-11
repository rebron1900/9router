import { describe, expect, it } from "vitest";
import { initState, translateResponse } from "../../open-sse/translator/index.js";

function feed(events) {
  const state = initState("openai-responses");
  const output = [];
  // The pipeline runs commandcode → openai → openai-responses. Keep the
  // intermediate OpenAI chunks too: role:"assistant" on the first delta only
  // exists there (the Responses translator drops it), and it is the observable
  // signal that per-field state init ran instead of being skipped.
  const openaiChunks = [];
  for (const event of events) {
    const translated = translateResponse("commandcode", "openai-responses", event, state);
    if (translated?._openaiIntermediate) openaiChunks.push(...translated._openaiIntermediate);
    output.push(...translated);
  }
  const flushed = translateResponse("commandcode", "openai-responses", null, state);
  output.push(...flushed);
  return { output, openaiChunks };
}

describe("CommandCode to Responses pipeline", () => {
  it("keeps text output visible to a Responses client and opens with role:assistant", () => {
    const { output, openaiChunks } = feed([
      { type: "text-delta", text: "hello" },
      { type: "finish-step", finishReason: "stop" },
      { type: "finish", totalUsage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } },
    ]);

    // Discriminating assertion: with a Responses client the shared state already
    // has responseId, so a responseId-guarded init would leave chunkIndex
    // undefined and drop role:"assistant" from the first delta.
    const firstDelta = openaiChunks[0]?.choices?.[0]?.delta;
    expect(firstDelta?.role).toBe("assistant");
    expect(firstDelta?.content).toBe("hello");

    const textDeltas = output.filter((event) => event.event === "response.output_text.delta");
    expect(textDeltas.map((event) => event.data.delta).join("")).toBe("hello");
    expect(output.some((event) => event.event === "response.completed")).toBe(true);
  });

  it("does not throw when a Responses client sends tools and CommandCode returns a tool call", () => {
    const { output } = feed([
      { type: "tool-input-start", id: "call_1", toolName: "lookup" },
      { type: "tool-input-delta", id: "call_1", delta: "{\"q\":\"x\"}" },
      { type: "finish-step", finishReason: "tool-calls" },
      { type: "finish" },
    ]);

    const added = output.find((event) => event.event === "response.output_item.added");
    expect(added?.data?.item?.type).toBe("function_call");
    expect(added?.data?.item?.name).toBe("lookup");
    expect(output.some((event) => event.event === "response.function_call_arguments.delta")).toBe(true);
    expect(output.some((event) => event.event === "response.completed")).toBe(true);
  });
});
