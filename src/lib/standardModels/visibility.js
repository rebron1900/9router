export const STANDARD_MODEL_VISIBILITY_SCOPE = "standard-model-routing";
export const COMBO_VISIBILITY_SCOPE = "combo";

export function isStandardModelHidden(disabledByProvider, publicName) {
  if (!publicName) return false;
  const disabled = disabledByProvider?.[STANDARD_MODEL_VISIBILITY_SCOPE];
  return Array.isArray(disabled) && disabled.includes(publicName);
}

export function createStandardModelVisibilityGroup(standardModels, disabledByProvider) {
  const models = (Array.isArray(standardModels) ? standardModels : [])
    .filter((model) =>
      model?.publicName
      && model.enabled !== false
      && Number(model.enabledProviderCount) > 0,
    )
    .map((model) => ({
      id: model.publicName,
      name: model.displayName || model.publicName,
      // Unified routes are intentionally managed as a dedicated child of the
      // LLM / Chat tab, even when a route advertises additional capabilities.
      kind: "llm",
      disabled: isStandardModelHidden(disabledByProvider, model.publicName),
    }));

  if (models.length === 0) return null;

  return {
    key: STANDARD_MODEL_VISIBILITY_SCOPE,
    storageAlias: STANDARD_MODEL_VISIBILITY_SCOPE,
    providerId: STANDARD_MODEL_VISIBILITY_SCOPE,
    iconProviderId: "",
    name: "Standard Model Routing",
    translatableName: true,
    color: "#7C3AED",
    textIcon: "UM",
    models,
    source: "standard",
  };
}

export function createComboVisibilityGroup(combos, disabledByProvider) {
  const models = (Array.isArray(combos) ? combos : [])
    .filter((combo) => combo?.name)
    .map((combo) => ({
      id: combo.name,
      name: combo.name,
      kind: combo.kind || "llm",
      disabled: isModelHidden(disabledByProvider, combo.name),
    }));

  if (models.length === 0) return null;

  return {
    key: COMBO_VISIBILITY_SCOPE,
    storageAlias: COMBO_VISIBILITY_SCOPE,
    providerId: COMBO_VISIBILITY_SCOPE,
    iconProviderId: "",
    name: "Combo & Vision Adapter",
    translatableName: true,
    color: "#F59E0B",
    textIcon: "CB",
    models,
    source: "combos",
  };
}

function isModelHidden(disabledByProvider, modelId) {
  const disabled = disabledByProvider?.[COMBO_VISIBILITY_SCOPE];
  return Array.isArray(disabled) && disabled.includes(modelId);
}
