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
