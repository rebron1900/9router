import { describe, expect, it } from "vitest";
import {
  STANDARD_MODEL_VISIBILITY_SCOPE,
  COMBO_VISIBILITY_SCOPE,
  createComboVisibilityGroup,
  createStandardModelVisibilityGroup,
  isStandardModelHidden,
} from "../../src/lib/standardModels/visibility.js";

describe("standard model visibility", () => {
  it("builds a dedicated LLM group from routable unified models", () => {
    const group = createStandardModelVisibilityGroup([
      {
        publicName: "claude-sonnet",
        displayName: "Claude Sonnet",
        enabled: true,
        enabledProviderCount: 2,
      },
      {
        publicName: "hidden-route",
        enabled: true,
        enabledProviderCount: 1,
      },
      {
        publicName: "disabled-route",
        enabled: false,
        enabledProviderCount: 1,
      },
      {
        publicName: "unbound-route",
        enabled: true,
        enabledProviderCount: 0,
      },
    ], {
      [STANDARD_MODEL_VISIBILITY_SCOPE]: ["hidden-route"],
    });

    expect(group).toMatchObject({
      key: STANDARD_MODEL_VISIBILITY_SCOPE,
      name: "Standard Model Routing",
      translatableName: true,
    });
    expect(group.models).toEqual([
      {
        id: "claude-sonnet",
        name: "Claude Sonnet",
        kind: "llm",
        disabled: false,
      },
      {
        id: "hidden-route",
        name: "hidden-route",
        kind: "llm",
        disabled: true,
      },
    ]);
  });

  it("uses a separate visibility scope without disabling routing records", () => {
    const disabled = {
      [STANDARD_MODEL_VISIBILITY_SCOPE]: ["shared-model"],
      openai: ["provider-model"],
    };

    expect(isStandardModelHidden(disabled, "shared-model")).toBe(true);
    expect(isStandardModelHidden(disabled, "provider-model")).toBe(false);
    expect(isStandardModelHidden(disabled, "other-model")).toBe(false);
  });

  it("omits the group when there are no enabled routes with providers", () => {
    expect(createStandardModelVisibilityGroup([
      { publicName: "disabled", enabled: false, enabledProviderCount: 1 },
      { publicName: "unbound", enabled: true, enabledProviderCount: 0 },
    ], {})).toBeNull();
  });

  it("builds a separate combo visibility group", () => {
    const group = createComboVisibilityGroup([
      { name: "fallback-combo", kind: null },
      { name: "web-search", kind: "webSearch" },
    ], {
      [COMBO_VISIBILITY_SCOPE]: ["web-search"],
    });

    expect(group).toMatchObject({
      key: COMBO_VISIBILITY_SCOPE,
      source: "combos",
    });
    expect(group.models).toEqual([
      { id: "fallback-combo", name: "fallback-combo", kind: "llm", disabled: false },
      { id: "web-search", name: "web-search", kind: "webSearch", disabled: true },
    ]);
  });
});
