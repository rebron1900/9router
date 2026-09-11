import { describe, expect, it } from "vitest";
import { openaiToCommandCodeRequest } from "../../open-sse/translator/request/openai-to-commandcode.js";

describe("openaiToCommandCodeRequest multimodal input", () => {
  it("converts an OpenAI data URI image to the CommandCode CLI image shape", () => {
    const result = openaiToCommandCodeRequest("z-ai/glm-5.3-flash", {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "识别图片中的内容" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        ],
      }],
    }, true);

    expect(result.params.messages[0].content).toEqual([
      { type: "text", text: "识别图片中的内容" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "aGVsbG8=",
        },
      },
    ]);
  });

  it("normalizes a Responses-style input_image into the CommandCode CLI image shape", () => {
    const result = openaiToCommandCodeRequest("z-ai/glm-5.3-flash", {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Read the image" },
          { type: "input_image", image_url: "data:image/jpeg;base64,ZmFrZQ==" },
        ],
      }],
    }, true);

    expect(result.params.messages[0].content).toEqual([
      { type: "text", text: "Read the image" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: "ZmFrZQ==",
        },
      },
    ]);
  });

  it("preserves a native Claude-style base64 image block", () => {
    const result = openaiToCommandCodeRequest("deepseek/deepseek-v4.1-flash", {
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/webp", data: "d2VicA==" } },
          { type: "text", text: "Inspect this image" },
        ],
      }],
    }, true);

    expect(result.params.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/webp", data: "d2VicA==" },
    });
  });

  it("does not silently send an unsupported remote URL shape", () => {
    const result = openaiToCommandCodeRequest("z-ai/glm-5.3-flash", {
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }],
      }],
    }, true);

    expect(result.params.messages[0].content).toEqual([{
      type: "text",
      text: "[image omitted: unable to fetch image for CommandCode]",
    }]);
  });
});
