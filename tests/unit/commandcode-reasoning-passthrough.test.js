import { describe, expect, it } from "vitest";
import { openaiToCommandCodeRequest } from "open-sse/translator/request/openai-to-commandcode.js";
import { translateRequest } from "open-sse/translator/index.js";
import { FORMATS } from "open-sse/translator/formats.js";

// Thinking mode requires the previous turn's reasoning to be echoed back to the
// upstream, or CommandCode rejects the request with:
//   "[CommandCode error: The `reasoning_content` in the thinking mode must be
//    passed back to the API]"
// The Responses client (Codex) delivers reasoning as a `reasoning` input item,
// which the first translation hop attaches to the assistant message as
// `reasoning_content`. This file locks the second hop: it must carry that
// through as a leading `reasoning` content block instead of dropping it.
describe("openaiToCommandCodeRequest — reasoning passthrough", () => {
  it("emits a leading reasoning block when the assistant message carries reasoning_content", () => {
    const out = openaiToCommandCodeRequest(
      "deepseek/deepseek-v4-flash",
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello", reasoning_content: "I reasoned about it" },
          { role: "user", content: "again" },
        ],
      },
      true,
    );

    const assistant = out.params.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content[0]).toEqual({ type: "reasoning", text: "I reasoned about it" });
    expect(assistant.content[1]).toEqual({ type: "text", text: "hello" });
  });

  it("keeps the reasoning block ahead of tool-call blocks", () => {
    const out = openaiToCommandCodeRequest(
      "deepseek/deepseek-v4-flash",
      {
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "calling a tool",
            reasoning_content: "tool needed",
            tool_calls: [{ id: "t1", function: { name: "f", arguments: '{"a":1}' } }],
          },
          { role: "tool", tool_call_id: "t1", name: "f", content: "ok" },
        ],
      },
      true,
    );

    const assistant = out.params.messages[1];
    expect(assistant.content[0]).toEqual({ type: "reasoning", text: "tool needed" });
    expect(assistant.content[1]).toEqual({ type: "text", text: "calling a tool" });
    expect(assistant.content[2]).toMatchObject({ type: "tool-call", toolCallId: "t1", toolName: "f" });
  });

  it("accepts a plain `reasoning` string as well", () => {
    const out = openaiToCommandCodeRequest(
      "deepseek/deepseek-v4-flash",
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello", reasoning: "plain reasoning" },
        ],
      },
      true,
    );
    expect(out.params.messages[1].content[0]).toEqual({ type: "reasoning", text: "plain reasoning" });
  });

  it("adds no reasoning block when there is none to replay", () => {
    const out = openaiToCommandCodeRequest(
      "deepseek/deepseek-v4-flash",
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
      true,
    );
    const assistant = out.params.messages[1];
    expect(assistant.content).toEqual([{ type: "text", text: "hello" }]);
    expect(assistant.content.some((b) => b.type === "reasoning")).toBe(false);
  });

  it("forwards the single-space placeholder used by reasoningContentInjector", () => {
    // reasoningContentInjector satisfies the upstream requirement with " " rather
    // than real text, so the check must be a length test, not a trim().
    const out = openaiToCommandCodeRequest(
      "deepseek/deepseek-v4-flash",
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello", reasoning_content: " " },
        ],
      },
      true,
    );
    expect(out.params.messages[1].content[0]).toEqual({ type: "reasoning", text: " " });
    expect(out.params.messages[1].content[1]).toEqual({ type: "text", text: "hello" });
  });

  it("ignores an empty reasoning_content string", () => {
    const out = openaiToCommandCodeRequest(
      "deepseek/deepseek-v4-flash",
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello", reasoning_content: "" },
        ],
      },
      true,
    );
    expect(out.params.messages[1].content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("survives the full openai-responses -> commandcode translation", () => {
    // End-to-end through the real registry: the reason this bug reached
    // production is that the loss happened on the *second* hop only, so a
    // single-hop unit test would have stayed green.
    const out = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-flash",
      {
        stream: true,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          { type: "reasoning", summary: [{ type: "summary_text", text: "I reasoned about it" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
        ],
      },
      true,
    );

    const assistant = out.params.messages.find((m) => m.role === "assistant");
    expect(assistant.content).toContainEqual({ type: "reasoning", text: "I reasoned about it" });
    expect(assistant.content).toContainEqual({ type: "text", text: "hello" });
  });
});
