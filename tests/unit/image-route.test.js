import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleImageGeneration: vi.fn(),
}));

vi.mock("../../src/sse/handlers/imageGeneration.js", () => mocks);

const { OPTIONS, POST } = await import("../../src/app/api/v1/images/edits/route.js");

describe("POST /v1/images/edits", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires an input image through the shared image handler", async () => {
    const expected = new Response(JSON.stringify({ ok: true }), { status: 200 });
    mocks.handleImageGeneration.mockResolvedValue(expected);

    const request = new Request("https://router.test/v1/images/edits", { method: "POST" });
    const response = await POST(request);

    expect(response).toBe(expected);
    expect(mocks.handleImageGeneration).toHaveBeenCalledWith(request, {
      operation: "edit",
      requireInputImage: true,
    });
  });

  it("exposes CORS preflight for multipart clients", async () => {
    const response = await OPTIONS();
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("*");
  });
});
