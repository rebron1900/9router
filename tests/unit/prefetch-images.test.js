import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/translator/concerns/image.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    fetchImageAsBase64: vi.fn(async () => ({ url: "data:image/png;base64,QUJD", mimeType: "image/png" })),
  };
});

import { prefetchRemoteImages } from "../../open-sse/translator/concerns/prefetch.js";
import { fetchImageAsBase64 } from "../../open-sse/translator/concerns/image.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

beforeEach(() => { fetchImageAsBase64.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("prefetchRemoteImages", () => {
  it("no-op for targets that accept remote URLs (openai)", async () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/a.png" } }] }] };
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.OPENAI);
    expect(n).toBe(0);
    expect(body.messages[0].content[0].image_url.url).toBe("https://x/a.png");
  });

  it("openai source -> ollama target: converts remote URL to base64", async () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/a.png" } }] }] };
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.OLLAMA);
    expect(n).toBe(1);
    expect(body.messages[0].content[0].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("openai source -> CommandCode target: converts a remote input_image URL", async () => {
    const body = { messages: [{ role: "user", content: [{ type: "input_image", image_url: "https://x/a.png" }] }] };
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.COMMANDCODE);
    expect(n).toBe(1);
    expect(body.messages[0].content[0].image_url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("normalizes a remote native image source before CommandCode translation", async () => {
    const body = { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/a.png" } }] }] };
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.COMMANDCODE);
    expect(n).toBe(1);
    expect(body.messages[0].content[0].source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: "QUJD",
    });
  });

  it("openai-responses source -> CommandCode target: converts input[].input_image URL", async () => {
    const body = { input: [{ role: "user", content: [
      { type: "input_text", text: "hi" },
      { type: "input_image", image_url: "https://x/a.png" },
    ] }] };
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI_RESPONSES, FORMATS.COMMANDCODE);
    expect(n).toBe(1);
    expect(body.input[0].content[1].image_url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("openai-responses source -> Gemini target: converts input[].image_url object form", async () => {
    const body = { input: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "https://x/b.jpg" } },
    ] }] };
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI);
    expect(n).toBe(1);
    expect(body.input[0].content[0].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("openai-responses source: normalizes a native image/source URL block", async () => {
    const body = { input: [{ role: "user", content: [
      { type: "image", source: { type: "url", url: "https://x/c.png" } },
    ] }] };
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI_RESPONSES, FORMATS.COMMANDCODE);
    expect(n).toBe(1);
    expect(body.input[0].content[0].source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: "QUJD",
    });
  });

  it("openai-responses source: skips string input and bare attachment refs without throwing", async () => {
    expect(await prefetchRemoteImages({ input: "just text" }, FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI)).toBe(0);
    const body = { input: [{ role: "user", content: [
      { type: "image", attachment: { file_id: "f_1" } },
      { type: "input_image", file_id: "f_2" },
    ] }] };
    expect(await prefetchRemoteImages(body, FORMATS.OPENAI_RESPONSES, FORMATS.COMMANDCODE)).toBe(0);
  });

  it("skips data URI (already inline)", async () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,xx" } }] }] };
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.OLLAMA);
    expect(n).toBe(0);
    expect(fetchImageAsBase64).not.toHaveBeenCalled();
  });

  it("gemini source -> gemini target: fileData URL -> inlineData base64", async () => {
    const body = { contents: [{ role: "user", parts: [
      { fileData: { mimeType: "image/png", fileUri: "https://x/a.png" } },
    ] }] };
    const n = await prefetchRemoteImages(body, FORMATS.GEMINI, FORMATS.GEMINI);
    expect(n).toBe(1);
    expect(body.contents[0].parts[0].inlineData).toBeTruthy();
    expect(body.contents[0].parts[0].fileData).toBeUndefined();
  });

  it("claude source -> kiro target: source.url -> base64", async () => {
    const body = { messages: [{ role: "user", content: [
      { type: "image", source: { type: "url", url: "https://x/a.png" } },
    ] }] };
    const n = await prefetchRemoteImages(body, FORMATS.CLAUDE, FORMATS.KIRO);
    expect(n).toBe(1);
    expect(body.messages[0].content[0].source.type).toBe("base64");
  });
});
