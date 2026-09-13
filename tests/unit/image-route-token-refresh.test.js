import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getStandardModelByName: vi.fn(),
  getStandardModelBindings: vi.fn(),
  updateProviderConnection: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(),
  isValidApiKey: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  handleComboChat: vi.fn(),
  handleImageGenerationCore: vi.fn(),
  planStandardModelCandidates: vi.fn(),
  refreshProviderCredentials: vi.fn(),
  shouldRefreshCredentials: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getStandardModelByName: mocks.getStandardModelByName,
  getStandardModelBindings: mocks.getStandardModelBindings,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("../../src/lib/localDb.js", () => ({
  getSettings: mocks.getSettings,
  getStandardModelByName: mocks.getStandardModelByName,
  getStandardModelBindings: mocks.getStandardModelBindings,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("open-sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("open-sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: mocks.handleComboChat,
}));

vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({
  handleImageGenerationCore: mocks.handleImageGenerationCore,
}));

vi.mock("@/lib/standardModels/planner", () => ({
  planStandardModelCandidates: mocks.planStandardModelCandidates,
}));

vi.mock("../../open-sse/services/oauthCredentialManager.js", () => ({
  refreshProviderCredentials: mocks.refreshProviderCredentials,
  shouldRefreshCredentials: mocks.shouldRefreshCredentials,
}));

import { handleImageGeneration } from "../../src/sse/handlers/imageGeneration.js";

describe("standard image route token refresh budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      standardModelRouting: { enabled: true, defaultPolicy: {} },
    });
    mocks.getStandardModelByName.mockResolvedValue({
      id: "standard-image",
      policy: { maxRouteDurationMs: 10 },
    });
    mocks.getStandardModelBindings.mockResolvedValue([{
      id: "binding-1",
      providerId: "openai",
      configured: true,
    }]);
    mocks.planStandardModelCandidates.mockReturnValue({
      candidates: [{ providerId: "openai", upstreamModelId: "dall-e-3" }],
      excluded: [],
    });
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "dall-e-3" });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.extractApiKey.mockReturnValue(null);
    mocks.isValidApiKey.mockResolvedValue(true);
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "connection-1",
      accessToken: "old-token",
      refreshToken: "refresh-token",
    });
    mocks.shouldRefreshCredentials.mockReturnValue(true);
    mocks.handleComboChat.mockImplementation(async ({ handleSingleModel, body, models }) => (
      handleSingleModel(body, models[0])
    ));
    mocks.handleImageGenerationCore.mockResolvedValue({
      success: true,
      response: new Response(JSON.stringify({ data: [{ url: "https://example.com/image.png" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the standard route deadline signal for token refresh even when the request remains open", async () => {
    let releaseRefresh;
    mocks.refreshProviderCredentials.mockImplementation(() => new Promise((resolve) => {
      releaseRefresh = resolve;
      setTimeout(() => resolve(null), 50);
    }));

    const request = new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "standard-image", prompt: "a cat" }),
    });

    const responsePromise = handleImageGeneration(request);
    await vi.advanceTimersByTimeAsync(60);
    const response = await responsePromise;
    await response.text();
    releaseRefresh?.(null);

    expect(mocks.refreshProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.handleImageGenerationCore).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
  });

  it("removes the refresh abort listener after the refresh promise settles", async () => {
    mocks.refreshProviderCredentials.mockResolvedValue(null);
    const signal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

    await checkAndRefreshToken("openai", {
      connectionId: "connection-1",
      refreshToken: "refresh-token",
    }, { signal });

    const onAbort = signal.addEventListener.mock.calls[0][1];
    expect(signal.addEventListener).toHaveBeenCalledWith("abort", onAbort, { once: true });
    expect(signal.removeEventListener).toHaveBeenCalledWith("abort", onAbort);
  });
});
