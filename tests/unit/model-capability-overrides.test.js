import { describe, expect, it } from "vitest";
import {
  getCapabilitiesForModel,
  mergeCapabilities,
  normalizeCapabilityOverrides,
} from "../../open-sse/providers/capabilities.js";
import { reorderByCapabilities } from "../../open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter } from "../../open-sse/services/capacityAdapter.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("request-scoped model capability overrides", () => {
  it("can promote a custom commandcode model to vision-capable", () => {
    const staticCaps = getCapabilitiesForModel("commandcode", "deepseek/deepseek-v4.1-flash");
    expect(staticCaps.vision).toBe(false);

    const effectiveCaps = mergeCapabilities(staticCaps, {
      vision: true,
      reasoning: true,
    });

    expect(effectiveCaps).toMatchObject({
      vision: true,
      reasoning: true,
    });
  });

  it("keeps static protocol metadata while ignoring invalid override fields", () => {
    const base = getCapabilitiesForModel("commandcode", "deepseek/deepseek-v4.1-flash");
    const clean = normalizeCapabilityOverrides({
      vision: true,
      thinkingFormat: "not-a-runtime-format",
      contextWindow: "not-a-number",
      arbitraryInternalFlag: true,
    });
    const effective = mergeCapabilities(base, clean);

    expect(clean).toEqual({ vision: true });
    expect(effective.thinkingFormat).toBe(base.thinkingFormat);
    expect(effective.contextWindow).toBe(base.contextWindow);
    expect(effective.arbitraryInternalFlag).toBeUndefined();
  });

  it("uses effective capabilities when reordering combo candidates", () => {
    const models = [
      "commandcode/deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-chat",
    ];
    const resolver = (provider, model) => mergeCapabilities(
      getCapabilitiesForModel(provider, model),
      provider === "commandcode" && model === "deepseek/deepseek-v4.1-flash"
        ? { vision: true }
        : null,
    );

    expect(reorderByCapabilities(models, new Set(["vision"]), resolver)).toEqual([
      "commandcode/deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-chat",
    ]);
  });

  it("keeps image input after the effective capability reaches chat translation", () => {
    const body = {
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,test" } }],
      }],
    };
    const capabilities = mergeCapabilities(
      getCapabilitiesForModel("commandcode", "deepseek/deepseek-v4.1-flash"),
      { vision: true, reasoning: true },
    );

    expect(stripUnsupportedModalities(body, FORMATS.OPENAI, capabilities)).toBe(true);
    expect(body.messages[0].content[0].type).toBe("image_url");
  });

  it("does not add a capacity fallback when a custom model satisfies vision", () => {
    const models = ["commandcode/deepseek/deepseek-v4.1-flash"];
    const resolver = (provider, model) => mergeCapabilities(
      getCapabilitiesForModel(provider, model),
      provider === "commandcode" ? { vision: true } : null,
    );
    const settings = {
      capacityAdapter: {
        vision: { enabled: true, models: ["cmc/vision-model"] },
      },
    };

    expect(augmentModelsWithCapacityAdapter(
      models,
      new Set(["vision"]),
      settings,
      resolver,
    )).toBe(models);
  });
});
