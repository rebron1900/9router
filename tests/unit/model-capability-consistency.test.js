import { describe, expect, it } from "vitest";
import { createCapabilityResolver, resolveCapabilities } from "@/lib/modelCapabilities.js";
import { findBundledStandardModel } from "@/lib/standardModels/catalog.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// The runtime (open-sse hot path) and the discovery layer (/v1/models) must
// advertise the same capabilities for the same model. Otherwise a client is
// told it may upload an image and the gateway silently strips it, which is the
// exact class of bug this aggregation point exists to prevent.
//
// Both sides are modelled here with the same call shape they use in
// production:
//   runtime  -> createCapabilityResolver(overrides)(provider, model, context)
//   display  -> resolveCapabilities({ provider, model, ...context })
describe("capability consistency between runtime and /v1/models", () => {
  const resolveRuntime = (provider, model, context = null, overrides = new Map()) =>
    createCapabilityResolver(overrides)(provider, model, context);
  const resolveDisplay = (provider, model, context = null) =>
    resolveCapabilities({ provider, model, ...(context || {}) });

  it("deepseek-v4-flash adopts the bundled catalog instead of the stale static table", () => {
    // The divergence that motivated the unification: the static name rules say
    // this model is text-only, the authoritative bundled catalog says vision.
    expect(getCapabilitiesForModel("deepseek", "deepseek-v4-flash").vision).toBe(false);
    expect(findBundledStandardModel("deepseek-v4-flash").capabilities.vision).toBe(true);

    const context = { publicName: "deepseek-v4-flash" };
    expect(resolveRuntime("deepseek", "deepseek-v4-flash", context).vision).toBe(true);
    expect(resolveDisplay("deepseek", "deepseek-v4-flash", context).vision).toBe(true);
  });

  it("gpt-5.6-luna falls back to the bundled catalog when the local record is empty", () => {
    // Stale DB rows carry an empty capabilities object; the bundled catalog is
    // authoritative for these standard models.
    const context = { publicName: "gpt-5.6-luna", persisted: {} };
    const runtime = resolveRuntime("openai", "gpt-5.6-luna", context);
    const display = resolveDisplay("openai", "gpt-5.6-luna", context);
    expect(runtime.vision).toBe(true);
    expect(display.vision).toBe(true);
    expect(runtime).toEqual(display);
  });

  it("a partial local object does not mask the catalog (field-level merge)", () => {
    // { tools: true } declares nothing about vision, so the catalog value must
    // survive. A whole-object override would have wiped vision to undefined.
    const context = { publicName: "deepseek-v4-flash", persisted: { tools: true } };
    const runtime = resolveRuntime("deepseek", "deepseek-v4-flash", context);
    const display = resolveDisplay("deepseek", "deepseek-v4-flash", context);
    expect(runtime.tools).toBe(true);
    expect(runtime.vision).toBe(true);
    expect(display.vision).toBe(true);
  });

  it("an explicit vision:false is honoured and never treated as undeclared", () => {
    const context = { publicName: "deepseek-v4-flash", persisted: { vision: false } };
    expect(resolveRuntime("deepseek", "deepseek-v4-flash", context).vision).toBe(false);
    expect(resolveDisplay("deepseek", "deepseek-v4-flash", context).vision).toBe(false);
  });

  it("a custom model with service-kind imageToText is vision on both sides", () => {
    // The custom-model path: /v1/models derives capabilities from the service
    // kind, so the runtime must derive them the same way or the two drift.
    const context = { serviceKind: "imageToText" };
    const runtime = resolveRuntime("custom", "my-ocr-model", context);
    const display = resolveDisplay("custom", "my-ocr-model", context);
    expect(runtime.vision).toBe(true);
    expect(display.vision).toBe(true);
    expect(runtime).toEqual(display);
  });

  it("honours a persisted service kind loaded from the local DB", () => {
    const overrides = new Map([
      ["custom\u0000my-ocr-model", { caps: {}, serviceKind: "imageToText" }],
    ]);
    expect(resolveRuntime("custom", "my-ocr-model", null, overrides).vision).toBe(true);
  });

  it("an explicit mapping override outranks every other layer", () => {
    const context = { publicName: "deepseek-v4-flash", overrides: { vision: false } };
    const runtime = resolveRuntime("deepseek", "deepseek-v4-flash", context);
    const display = resolveDisplay("deepseek", "deepseek-v4-flash", context);
    expect(runtime.vision).toBe(false);
    expect(display.vision).toBe(false);
  });

  it("agrees across every bundled standard model", () => {
    // Guards the invariant rather than one hard-coded case: for each model in
    // the authoritative catalog, runtime and display must be identical.
    const names = [
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "deepseek-v4-flash",
      "glm-5.3-flash",
    ];
    for (const publicName of names) {
      const context = { publicName, persisted: {} };
      expect(resolveRuntime("", publicName, context)).toEqual(
        resolveDisplay("", publicName, context),
      );
    }
  });
});
