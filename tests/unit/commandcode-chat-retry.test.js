import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  handleChatCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(() => true),
}));

vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: vi.fn(),
}));

vi.mock("../../src/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(),
  clearAntigravityStrikes: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getStandardModelByName: vi.fn(),
  getStandardModelBindings: vi.fn(),
}));

vi.mock("@/lib/modelCapabilities", () => ({
  createCapabilityResolver: vi.fn(() => () => ({})),
  loadCustomModelCapabilityOverrides: vi.fn(async () => ({})),
  resolveCapabilities: vi.fn(() => ({})),
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: mocks.handleChatCore,
}));

vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn(),
}));

const { handleSingleModelChat } = await import("../../src/sse/handlers/chat.js");

const MODEL = "deepseek/deepseek-v4.1-flash";
const MODEL_PATH = `commandcode/${MODEL}`;
const GATEWAY_ERROR = "[CommandCode error: Invalid error response format: Gateway request failed]";

function connection(id) {
  return {
    connectionId: id,
    connectionName: id,
    apiKey: `${id}-key`,
    providerSpecificData: {},
  };
}

function failure(status = 520, message = GATEWAY_ERROR) {
  return {
    success: false,
    status,
    error: message,
    response: new Response(JSON.stringify({ error: { message } }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

function success(connectionId = "conn-a") {
  return {
    success: true,
    response: Response.json({ ok: true, connectionId }),
  };
}

function request(signal = undefined) {
  return new Request("https://router.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL_PATH,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
    signal,
  });
}

function routeContext(overrides = {}) {
  return {
    standardRoute: true,
    standardModelPublicName: "deepseek-v4.1-flash",
    maxAccountAttempts: 2,
    ...overrides,
  };
}

function useRoundRobinSimulation() {
  const first = connection("conn-a");
  const second = connection("conn-b");
  let unpinnedSelections = 0;
  mocks.getProviderCredentials.mockImplementation(async (_provider, _excluded, _model, options = {}) => {
    if (options.preferredConnectionId === first.connectionId) return first;
    unpinnedSelections += 1;
    return unpinnedSelections === 1 ? first : second;
  });
  return { first, second };
}

describe("CommandCode transient chat retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({});
    mocks.getModelInfo.mockResolvedValue({ provider: "commandcode", model: MODEL });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false, cooldownMs: 0 });
  });

  it("pins the one-shot retry to the account that received the gateway error", async () => {
    const { first } = useRoundRobinSimulation();
    mocks.handleChatCore
      .mockResolvedValueOnce(failure())
      .mockResolvedValueOnce(success(first.connectionId));

    const response = await handleSingleModelChat(
      { model: MODEL_PATH, messages: [{ role: "user", content: "hello" }], stream: true },
      MODEL_PATH,
      null,
      request(),
      null,
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, connectionId: first.connectionId });
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(mocks.getProviderCredentials.mock.calls[1][3]).toMatchObject({
      preferredConnectionId: first.connectionId,
    });
    expect(mocks.handleChatCore.mock.calls[1][0].credentials.connectionId).toBe(first.connectionId);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("locks the retried account only after the second gateway failure", async () => {
    const { first } = useRoundRobinSimulation();
    mocks.handleChatCore.mockResolvedValue(failure());

    const response = await handleSingleModelChat(
      { model: MODEL_PATH, messages: [{ role: "user", content: "hello" }], stream: true },
      MODEL_PATH,
      null,
      request(),
      null,
      routeContext(),
    );

    expect(response.status).toBe(520);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledTimes(1);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      first.connectionId,
      520,
      GATEWAY_ERROR,
      "commandcode",
      MODEL,
      undefined,
    );
  });

  it("does not exceed maxAccountAttempts when the policy allows one request", async () => {
    const { first } = useRoundRobinSimulation();
    mocks.handleChatCore.mockResolvedValue(failure());

    const response = await handleSingleModelChat(
      { model: MODEL_PATH, messages: [{ role: "user", content: "hello" }], stream: true },
      MODEL_PATH,
      null,
      request(),
      null,
      routeContext({ maxAccountAttempts: 1 }),
    );

    expect(response.status).toBe(520);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledOnce();
    expect(mocks.markAccountUnavailable.mock.calls[0][0]).toBe(first.connectionId);
  });

  it("stops before retrying when the shared route budget is exhausted", async () => {
    useRoundRobinSimulation();
    let available = true;
    const attemptBudget = {
      canAttempt: vi.fn(() => available),
      snapshot: vi.fn(() => ({ timedOut: false, attempts: available ? 0 : 1, maxAttempts: 1 })),
    };
    mocks.handleChatCore.mockImplementationOnce(async () => {
      available = false;
      return failure();
    });

    const response = await handleSingleModelChat(
      { model: MODEL_PATH, messages: [{ role: "user", content: "hello" }], stream: true },
      MODEL_PATH,
      null,
      request(),
      null,
      routeContext({ attemptBudget }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("attempt_budget_exhausted");
    expect(mocks.handleChatCore).toHaveBeenCalledOnce();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("aborts the retry wait without locking the account", async () => {
    vi.useFakeTimers();
    try {
      useRoundRobinSimulation();
      const controller = new AbortController();
      mocks.handleChatCore.mockResolvedValueOnce(failure());
      const execution = handleSingleModelChat(
        { model: MODEL_PATH, messages: [{ role: "user", content: "hello" }], stream: true },
        MODEL_PATH,
        null,
        request(controller.signal),
        null,
        routeContext({ signal: controller.signal }),
      );
      setTimeout(() => controller.abort(), 10);
      await vi.advanceTimersByTimeAsync(10);

      const response = await execution;

      expect(response.status).toBe(499);
      expect(mocks.handleChatCore).toHaveBeenCalledOnce();
      expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
