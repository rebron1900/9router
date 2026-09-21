import {
  getProviderModelCatalog,
  upsertProviderModelCatalog,
  getCustomModels,
} from "@/lib/db/index.js";
import { getProviderAlias } from "@/shared/constants/providers.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getModelType } from "open-sse/config/providerModels.js";
import { normalizeProviderModel } from "@/shared/utils/providerModelCatalog.js";

function modelKind(providerId, modelId, rawModel) {
  return rawModel?.kind || rawModel?.type || getModelType(providerId, modelId) || "llm";
}

function normalizeDiscoveredModel(rawModel, providerId, providerAlias) {
  const normalized = normalizeProviderModel(rawModel, { providerId, providerAlias });
  if (!normalized) return null;
  const kind = modelKind(providerId, normalized.id, normalized);
  const capabilities = normalized.capabilities || normalized.caps || getCapabilitiesForModel(providerId, normalized.id);
  return {
    ...normalized,
    id: normalized.id,
    model: normalized.id,
    kind,
    capabilities,
    ...(normalized.contextLength ? { contextLength: normalized.contextLength } : {}),
    ...(normalized.maxOutputTokens ? { maxOutputTokens: normalized.maxOutputTokens } : {}),
  };
}

export async function persistProviderModelCatalog(providerId, models, options = {}) {
  const normalized = (Array.isArray(models) ? models : [])
    .map((model) => normalizeDiscoveredModel(model, providerId, options.providerAlias))
    .filter(Boolean);
  return upsertProviderModelCatalog(providerId, normalized, options);
}

export async function getDiscoveredProviderModels(providerId) {
  return getProviderModelCatalog(providerId);
}

export async function getUnifiedProviderModels(providerId) {
  const [catalog, customModels] = await Promise.all([
    getProviderModelCatalog(providerId),
    getCustomModels(),
  ]);
  const rows = Array.isArray(customModels)
    ? customModels
      .filter((model) => !providerId || model.providerAlias === providerId)
      .map((model) => ({
        providerId: model.providerAlias,
        modelId: model.id,
        kind: model.kind || model.type || "llm",
        name: model.name || model.id,
        capabilities: model.caps,
        source: "manual",
        stale: false,
      }))
    : [];
  const merged = new Map();
  for (const row of [...rows, ...catalog]) {
    const providerKey = row.providerAlias || getProviderAlias(row.providerId) || row.providerId;
    const key = `${providerKey}|${row.modelId}|${row.kind || "llm"}`;
    merged.set(key, {
      ...row,
      providerId: row.providerId,
      providerAlias: providerKey,
    });
  }
  return [...merged.values()];
}

export function catalogModelToDashboardModel(row) {
  if (!row?.providerId || !row?.modelId) return null;
  return {
    provider: row.providerId,
    providerAlias: row.providerAlias || getProviderAlias(row.providerId) || row.providerId,
    model: row.modelId,
    id: row.modelId,
    name: row.name || row.modelId,
    kind: row.kind || "llm",
    disabled: false,
    catalogSource: row.source || "discovered",
    catalogStale: row.stale === true,
    lastSeenAt: row.lastSeenAt,
    ...(row.capabilities ? { capabilities: row.capabilities, caps: row.capabilities } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.contextLength ? { contextLength: row.contextLength } : {}),
    ...(row.maxOutputTokens ? { maxOutputTokens: row.maxOutputTokens } : {}),
  };
}

export function catalogModelToRoutingModel(row) {
  const model = catalogModelToDashboardModel(row);
  if (!model || model.catalogStale) return null;
  return model;
}

export function normalizeCatalogForProvider(models, providerId, providerAlias) {
  return (Array.isArray(models) ? models : [])
    .map((model) => normalizeDiscoveredModel(model, providerId, providerAlias))
    .filter(Boolean);
}
