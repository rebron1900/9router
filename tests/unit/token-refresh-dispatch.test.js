// Guards the refactored REFRESH_HANDLERS dispatch: null-guards + the two different defaults.
import { describe, it, expect } from "vitest";
import { refreshWithRetry } from "../../open-sse/services/tokenRefresh.js";

const load = () => import("../../open-sse/services/tokenRefresh.js");

describe("tokenRefresh dispatch", () => {
  it("getAccessToken returns null for missing/invalid refreshToken", async () => {
    const mod = await load();
    expect(await mod.getAccessToken("claude", {}, null)).toBeNull();
    expect(await mod.getAccessToken("claude", { refreshToken: 123 }, null)).toBeNull();
  });

  it("getAccessToken default: unsupported provider → null", async () => {
    const mod = await load();
    expect(await mod.getAccessToken("totally-unknown", { refreshToken: "x" }, null)).toBeNull();
  });

  it("refreshTokenByProvider returns null without refreshToken", async () => {
    const mod = await load();
    expect(await mod.refreshTokenByProvider("claude", {}, null)).toBeNull();
  });

  it("rethrows an abort raised by the final refresh attempt", async () => {
    const controller = new AbortController();
    const reason = new Error("route deadline");
    const refreshFn = async () => {
      controller.abort(reason);
      throw reason;
    };

    await expect(refreshWithRetry(refreshFn, 1, null, controller.signal)).rejects.toBe(reason);
  });

  it("checks for cancellation before returning null after an aborted refresh result", async () => {
    const controller = new AbortController();
    const reason = new Error("client disconnected");
    const refreshFn = async () => {
      controller.abort(reason);
      return null;
    };

    await expect(refreshWithRetry(refreshFn, 1, null, controller.signal)).rejects.toBe(reason);
  });
});
