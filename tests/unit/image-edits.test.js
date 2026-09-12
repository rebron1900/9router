import { afterEach, describe, expect, it, vi } from "vitest";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import codex from "../../open-sse/handlers/imageProviders/codex.js";

afterEach(() => vi.unstubAllGlobals());

describe("image edits provider adapters", () => {
  it("builds a Codex edit action with the normalized input mask field", () => {
    const body = codex.buildBody("gpt-image-2", {
      _imageOperation: "edit",
      prompt: "Remove the sign",
      image: "data:image/png;base64,c291cmNl",
      mask_image: "data:image/jpeg;base64,bWFzaw==",
      output_format: "WEBP",
    });

    expect(body.tools[0]).toMatchObject({
      type: "image_generation",
      action: "edit",
      model: "gpt-image-2",
      input_image_mask: { image_url: "data:image/jpeg;base64,bWFzaw==" },
      output_format: "webp",
    });
    expect(body.input[0].content).toContainEqual({
      type: "input_image",
      image_url: "data:image/png;base64,c291cmNl",
      detail: "high",
    });
  });

  it("uses the OpenAI edits endpoint and leaves multipart content type to fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ created: 1, data: [{ b64_json: "cmVzdWx0" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));

    const result = await handleImageGenerationCore({
      body: {
        _imageOperation: "edit",
        prompt: "Make it warmer",
        image: "data:image/png;base64,c291cmNl",
        mask: "data:image/png;base64,bWFzaw==",
        n: 1,
        size: "1024x1024",
        response_format: "b64_json",
      },
      modelInfo: { provider: "openai", model: "gpt-image-1" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/edits");
    expect(options.headers.Authorization).toBe("Bearer test-key");
    expect(options.headers["Content-Type"]).toBeUndefined();
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.getAll("image")).toHaveLength(1);
    expect(options.body.get("mask")).toBeInstanceOf(Blob);
  });
});
