function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalize the different model shapes returned by provider /models APIs.
 * Provider-prefixed ids are removed only when the prefix is the provider id
 * or alias; ids such as `anthropic/claude-sonnet` remain intact.
 */
export function normalizeProviderModel(rawModel, { providerId, providerAlias } = {}) {
  if (typeof rawModel === "string") rawModel = { id: rawModel };
  if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) return null;

  const rawId = stringValue(rawModel.id || rawModel.model || rawModel.name);
  if (!rawId) return null;

  const prefixes = [providerId, providerAlias]
    .map(stringValue)
    .filter(Boolean)
    .map((prefix) => `${prefix}/`);
  const id = prefixes.reduce(
    (current, prefix) => (current.startsWith(prefix) ? current.slice(prefix.length) : current),
    rawId,
  );
  if (!id) return null;

  return {
    ...rawModel,
    id,
    name: stringValue(rawModel.name || rawModel.displayName || rawModel.label) || id,
  };
}

/**
 * Merge a provider's built-in catalog with a live catalog. Live metadata wins
 * for duplicate ids, while live-only ids are retained. This keeps the page
 * useful when an upstream provider publishes a model not yet in the static
 * registry, and still gives us a safe static fallback when live discovery
 * fails.
 */
export function mergeProviderModelCatalog({
  staticModels = [],
  liveModels = [],
  providerId,
  providerAlias,
} = {}) {
  const merged = new Map();
  const add = (rawModel, isLive) => {
    const model = normalizeProviderModel(rawModel, { providerId, providerAlias });
    if (!model) return;
    const previous = merged.get(model.id) || {};
    merged.set(model.id, {
      ...previous,
      ...model,
      id: model.id,
      name: model.name || previous.name || model.id,
      ...(isLive ? { isLive: true } : {}),
    });
  };

  staticModels.forEach((model) => add(model, false));
  liveModels.forEach((model) => add(model, true));
  return [...merged.values()];
}
