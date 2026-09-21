import { describe, expect, it } from "vitest";
import {
  mergeProviderModelCatalog,
  normalizeProviderModel,
} from "@/shared/utils/providerModelCatalog.js";

describe("provider model catalog", () => {
  it("normalizes provider-prefixed ids without touching vendor/model ids", () => {
    expect(normalizeProviderModel(
      { id: "qoder/ultimate", displayName: "Ultimate" },
      { providerId: "qoder", providerAlias: "qd" },
    )).toMatchObject({ id: "ultimate", name: "Ultimate" });

    expect(normalizeProviderModel(
      { id: "anthropic/claude-sonnet-4.6" },
      { providerId: "cline", providerAlias: "cl" },
    )).toMatchObject({ id: "anthropic/claude-sonnet-4.6" });
  });

  it("normalizes durable catalog records", async () => {
    const { normalizeProviderCatalogModel } = await import("../../src/lib/db/repos/modelCatalogRepo.js");
    expect(normalizeProviderCatalogModel(
      { id: "zen/gpt-4o", display_name: "GPT-4o" },
      { providerId: "openai-compatible-chat-node", providerAlias: "zen", now: "2026-01-01T00:00:00.000Z" },
    )).toMatchObject({
      providerId: "openai-compatible-chat-node",
      modelId: "gpt-4o",
      name: "gpt-4o",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      stale: false,
    });
  });

  it("lets live models override static metadata and keeps live-only models", () => {
    expect(mergeProviderModelCatalog({
      providerId: "openai",
      staticModels: [{ id: "gpt-4o", name: "Static name" }],
      liveModels: [
        { id: "gpt-4o", name: "Live name", contextLength: 128000 },
        { id: "gpt-5", name: "GPT-5" },
      ],
    })).toEqual([
      { id: "gpt-4o", name: "Live name", contextLength: 128000, isLive: true },
      { id: "gpt-5", name: "GPT-5", isLive: true },
    ]);
  });
});
