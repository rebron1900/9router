import { describe, expect, it } from "vitest";
import {
  configuredModelIds,
  hasExplicitModelAllowlist,
  isModelHidden,
  normalizeModelIds,
} from "../../src/lib/modelDiscovery.js";

describe("model discovery policy", () => {
  it("treats an empty enabledModels array as an explicit empty allowlist", () => {
    const connection = { providerSpecificData: { enabledModels: [] } };
    expect(hasExplicitModelAllowlist(connection)).toBe(true);
    expect(configuredModelIds({
      connection,
      staticModelIds: ["should-not-appear"],
      customModelIds: [],
      aliasModelIds: [],
    })).toEqual([]);
  });

  it("keeps persisted catalog models in the configured base list", () => {
    const connection = { providerSpecificData: {} };
    expect(configuredModelIds({
      connection,
      staticModelIds: ["catalog-model"],
      customModelIds: [],
      aliasModelIds: [],
    })).toEqual(["catalog-model"]);
  });

  it("keeps registered custom models while excluding unregistered upstream models", () => {
    const connection = { providerSpecificData: {} };
    expect(configuredModelIds({
      connection,
      staticModelIds: [],
      customModelIds: ["imported-a", "imported-b"],
      aliasModelIds: [],
    })).toEqual(["imported-a", "imported-b"]);
  });

  it("normalizes model records and removes duplicates", () => {
    expect(normalizeModelIds([
      " model-a ",
      { id: "model-b" },
      { model: "model-a" },
      "",
      null,
    ])).toEqual(["model-a", "model-b"]);
  });

  it("checks hidden state across provider aliases", () => {
    expect(isModelHidden({ custom: ["hidden-model"] }, ["custom", "node-id"], "hidden-model")).toBe(true);
    expect(isModelHidden({ custom: ["hidden-model"] }, ["other"], "hidden-model")).toBe(false);
  });
});
