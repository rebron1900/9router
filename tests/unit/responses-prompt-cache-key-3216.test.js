import { describe, expect, it } from "vitest";

const { openaiToOpenAIResponsesRequest, openaiResponsesToOpenAIRequest } =
  await import("../../open-sse/translator/request/openai-responses.js");
const { normalizeResponsesInputImages } =
  await import("../../open-sse/translator/formats/responsesApi.js");

const CHAT_BODY = (extra = {}) => ({
  model: "example-model",
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});

describe("#3216 prompt_cache_key across the chat/responses translation", () => {
  it("preserves an explicit key when converting chat → responses", () => {
    const out = openaiToOpenAIResponsesRequest(
      "example-model",
      CHAT_BODY({ prompt_cache_key: "stable-cache-key" }),
      true,
      {},
    );

    expect(out.prompt_cache_key).toBe("stable-cache-key");
  });

  it("does not invent a key when the client sent none", () => {
    const out = openaiToOpenAIResponsesRequest("example-model", CHAT_BODY(), true, {});

    expect(out.prompt_cache_key).toBeUndefined();
  });

  it("preserves DSH native base64 image blocks when converting chat → responses", () => {
    const out = openaiToOpenAIResponsesRequest("example-model", {
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGVsbG8=" } },
          { type: "text", text: "What is in this image?" },
        ],
      }],
    }, true, {});

    expect(out.input[0].content).toEqual([
      { type: "input_image", image_url: "data:image/jpeg;base64,aGVsbG8=", detail: "auto" },
      { type: "input_text", text: "What is in this image?" },
    ]);
  });

  it("materializes data-URI message attachments as Responses input_image blocks", () => {
    const out = openaiToOpenAIResponsesRequest("example-model", {
      messages: [{
        role: "user",
        content: "Describe the attachment.",
        experimental_attachments: [{ contentType: "image/png", url: "data:image/png;base64,aGVsbG8=" }],
      }],
    }, true, {});

    expect(out.input[0].content).toEqual([
      { type: "input_text", text: "Describe the attachment." },
      { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "auto" },
    ]);
  });

  it("normalizes native DSH images already inside a Responses input body", () => {
    const body = {
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          { type: "input_text", text: "Inspect it." },
        ],
      }],
    };

    expect(normalizeResponsesInputImages(body)).toBe(true);
    expect(body.input[0].content[0]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,aGVsbG8=",
      detail: "auto",
    });
  });

  it("converts native DSH images on the Responses → Chat direction", () => {
    const out = openaiResponsesToOpenAIRequest("example-model", {
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGVsbG8=" } },
        ],
      }],
    }, true, {});

    expect(out.messages[0].content[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,aGVsbG8=", detail: "auto" },
    });
  });

  it("does not turn an unmaterialized DSH attachment reference into an empty image URL", () => {
    const reference = { type: "image", attachment: { attachmentId: "sha256:owned-by-dsh" } };
    const out = openaiResponsesToOpenAIRequest("example-model", {
      input: [{ type: "message", role: "user", content: [reference] }],
    }, true, {});

    expect(out.messages[0].content[0]).toEqual(reference);
  });

  it("still drops the key on the responses → chat direction", () => {
    const out = openaiResponsesToOpenAIRequest(
      "example-model",
      {
        model: "example-model",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        prompt_cache_key: "stable-cache-key",
      },
      true,
      {},
    );

    expect(out.prompt_cache_key).toBeUndefined();
  });
});
