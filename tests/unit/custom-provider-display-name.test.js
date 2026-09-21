import { describe, it, expect, beforeEach, vi } from "vitest";

// Custom provider nodes are addressed by opaque generated ids
// ("openai-compatible-chat-<uuid>"). Routing must keep the raw id, but display
// surfaces should render the user-configured node name ("opencode zen/...").
const mocks = vi.hoisted(() => ({
  getProviderNodes: vi.fn(),
  getProviderNodeById: vi.fn(),
  getModelAliases: vi.fn(),
  getComboByName: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderNodes: mocks.getProviderNodes,
  getProviderNodeById: mocks.getProviderNodeById,
  getModelAliases: mocks.getModelAliases,
  getComboByName: mocks.getComboByName,
}));

const { getModelInfo } = await import("../../src/sse/services/model.js");

const NODE = {
  id: "openai-compatible-chat-3acd0101-bd3b-4f95-8679-3e90df115d03",
  type: "openai-compatible",
  name: "opencode zen",
  prefix: "zen",
  apiType: "chat",
};

describe("custom provider display name resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderNodes.mockImplementation(async ({ type } = {}) =>
      type === "openai-compatible" ? [NODE] : []);
    mocks.getProviderNodeById.mockResolvedValue(NODE);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getComboByName.mockResolvedValue(null);
  });

  it("attaches the node name when resolved via the configured prefix", async () => {
    const info = await getModelInfo("zen/deepseek-v4-flash");
    expect(info.provider).toBe(NODE.id);
    expect(info.model).toBe("deepseek-v4-flash");
    expect(info.providerName).toBe("opencode zen");
  });

  it("attaches the node name when the raw node id is used in the model string", async () => {
    const info = await getModelInfo(`${NODE.id}/deepseek-v4-flash`);
    expect(info.provider).toBe(NODE.id);
    expect(info.providerName).toBe("opencode zen");
  });

  it("leaves built-in providers untouched (no providerName)", async () => {
    const info = await getModelInfo("deepseek/deepseek-v4-flash");
    expect(info).toEqual({ provider: "deepseek", model: "deepseek-v4-flash" });
  });
});
