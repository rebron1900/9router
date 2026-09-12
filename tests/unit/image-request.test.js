import { describe, expect, it } from "vitest";
import { ImageRequestError, parseImageRequest } from "../../src/sse/handlers/imageRequest.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("image request parser", () => {
  it("normalizes JSON image and mask aliases without duplicating the primary image", async () => {
    const request = new Request("https://router.test/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-edit",
        prompt: "Replace the sky",
        image: "data:image/png;base64,cmVm",
        images: [{ image_url: { url: "data:image/png;base64,cmVm" } }],
        maskImage: { image_url: "data:image/jpeg;base64,bWFzaw==" },
      }),
    });

    const body = await parseImageRequest(request, { requireInputImage: true });

    expect(body.images).toEqual(["data:image/png;base64,cmVm"]);
    expect(body.image).toBe("data:image/png;base64,cmVm");
    expect(body.mask).toBe("data:image/jpeg;base64,bWFzaw==");
    expect(body.mask_image).toBe(body.mask);
    expect(body.maskImage).toBe(body.mask);
  });

  it("accepts repeated multipart files and uses the detected MIME type", async () => {
    const form = new FormData();
    form.append("model", "gpt-image-edit");
    form.append("prompt", "Keep the subject, change the colors");
    form.append("n", "2");
    form.append("image", new Blob([PNG_BYTES], { type: "image/jpeg" }), "source.jpg");
    form.append("image", new Blob([PNG_BYTES], { type: "image/png" }), "second.png");
    form.append("mask", new Blob([PNG_BYTES], { type: "image/png" }), "mask.png");

    const request = new Request("https://router.test/v1/images/edits", { method: "POST", body: form });
    const body = await parseImageRequest(request, { requireInputImage: true });

    expect(body.n).toBe(2);
    expect(body.images).toHaveLength(2);
    expect(body.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(body.mask).toMatch(/^data:image\/png;base64,/);
  });

  it("rejects edits without an input image", async () => {
    const request = new Request("https://router.test/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-edit", prompt: "Edit this" }),
    });

    await expect(parseImageRequest(request, { requireInputImage: true }))
      .rejects.toMatchObject({ name: ImageRequestError.name, status: 400, message: "Missing required field: image" });
  });
});
