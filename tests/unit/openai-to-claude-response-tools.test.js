import { describe, expect, it } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

function createState() {
  return { toolCalls: new Map(), nextBlockIndex: 0 };
}

function getInputJsonDelta(events) {
  return events.find((event) => event.type === "content_block_delta" && event.delta?.type === "input_json_delta")?.delta.partial_json;
}

describe("openaiToClaudeResponse tool argument sanitization", () => {
  it("drops invalid Read pages and clamps numeric bounds", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-read",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_read", function: { name: "Read" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-read",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "F:/repo/file.js", offset: -5, limit: 999999999, pages: "" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/file.js",
      offset: 0,
      limit: 2000,
    });
  });

  it("keeps valid PDF pages", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-pdf",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_pdf", function: { name: "proxy_Read" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-pdf",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "F:/repo/doc.pdf", pages: "1-3" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/doc.pdf",
      pages: "1-3",
    });
  });
});

describe("openaiToClaudeResponse usage framing", () => {
  it("captures cache usage from a terminal choices-empty chunk", () => {
    const state = createState();

    const events = openaiToClaudeResponse({
      id: "chatcmpl-usage-only",
      model: "test-model",
      choices: [],
      usage: {
        prompt_tokens: 500,
        completion_tokens: 20,
        input_tokens_details: { cached_tokens: 480 },
      },
    }, state);

    expect(events).toBeNull();
    expect(state.usage).toEqual({
      input_tokens: 20,
      output_tokens: 20,
      cache_read_input_tokens: 480,
    });
  });

  it("holds the Claude terminal until a later usage-only chunk arrives", () => {
    const state = createState();
    openaiToClaudeResponse({
      id: "chatcmpl-delayed-usage",
      model: "test-model",
      choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-delayed-usage",
      model: "test-model",
      choices: [],
      usage: { prompt_tokens: 500, completion_tokens: 20, cached_tokens: 480 },
    }, state);
    const messageDelta = events?.find((event) => event.type === "message_delta");

    expect(messageDelta?.usage).toEqual({
      input_tokens: 20,
      output_tokens: 20,
      cache_read_input_tokens: 480,
    });
    expect(events?.at(-1)?.type).toBe("message_stop");
  });
});
