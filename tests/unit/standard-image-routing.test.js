import { describe, expect, it } from "vitest";
import { planStandardModelCandidates } from "../../src/lib/standardModels/planner.js";

const model = {
  id: "standard-image",
  publicName: "studio-image",
  enabled: true,
  requiredCapabilities: { imageOutput: true },
};

const bindings = [
  {
    id: "provider-a",
    providerId: "openai",
    configured: true,
    priority: 1,
    mappings: [{ id: "generation", upstreamModelId: "gpt-image-1", requestFormats: ["openai-images"], operations: ["generation"] }],
  },
  {
    id: "provider-b",
    providerId: "codex",
    configured: true,
    priority: 2,
    mappings: [{ id: "edit", upstreamModelId: "gpt-image-2", requestFormats: ["openai-images"], operations: ["edit"] }],
  },
];

describe("standard image planner", () => {
  it("selects the generation mapping only for generations", () => {
    const plan = planStandardModelCandidates({ model, bindings, requestFormat: "openai-images", operation: "generation", requireConfiguredProvider: true });
    expect(plan.candidates.map((candidate) => candidate.upstreamModelId)).toEqual(["gpt-image-1"]);
    expect(plan.operation).toBe("generation");
  });

  it("selects the edit mapping only for edits and preserves provider order", () => {
    const plan = planStandardModelCandidates({ model, bindings, requestFormat: "openai-images", operation: "edit", requireConfiguredProvider: true });
    expect(plan.candidates.map((candidate) => `${candidate.providerId}/${candidate.upstreamModelId}`)).toEqual(["codex/gpt-image-2"]);
    expect(plan.operation).toBe("edit");
  });
});
