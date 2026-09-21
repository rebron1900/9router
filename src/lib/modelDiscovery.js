/**
 * Helpers shared by model discovery and its acceptance tests.
 *
 * A compatible provider may persist successful upstream model discovery.
 * The provider's enabledModels array is authoritative when present, including
 * an empty array. Persisted custom models and aliases are registered additions.
 */

export function normalizeModelIds(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => {
        if (typeof value === "string") return value.trim();
        return String(value?.id || value?.model || value?.name || "").trim();
      })
      .filter(Boolean),
  ));
}

export function hasExplicitModelAllowlist(connection) {
  return Array.isArray(connection?.providerSpecificData?.enabledModels);
}

export function configuredModelIds({ connection, staticModelIds = [], customModelIds = [], aliasModelIds = [] }) {
  const explicit = connection?.providerSpecificData?.enabledModels;
  const base = hasExplicitModelAllowlist(connection)
    ? normalizeModelIds(explicit)
    : normalizeModelIds(staticModelIds);

  return normalizeModelIds([
    ...base,
    ...customModelIds,
    ...aliasModelIds,
  ]);
}

export function isModelHidden(disabledByAlias, aliases, modelId) {
  if (!modelId || !disabledByAlias || !Array.isArray(aliases)) return false;
  return aliases.some((alias) => (
    Array.isArray(disabledByAlias[alias]) && disabledByAlias[alias].includes(modelId)
  ));
}

