import {
  getModelAliases,
  getComboByName,
  getStandardModelByName,
} from "@/lib/localDb";

export const STANDARD_MODEL_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function normalizeStandardModelInput(body = {}) {
  const publicName = String(body.publicName || body.name || "").trim();
  const officialModelId = String(body.officialModelId || publicName).trim();
  if (!publicName) throw new Error("publicName is required");
  if (!STANDARD_MODEL_NAME_REGEX.test(publicName)) {
    throw new Error("publicName may only contain letters, numbers, dots, underscores, and hyphens");
  }
  if (!officialModelId) throw new Error("officialModelId is required");
  return {
    publicName,
    officialModelId,
    publisher: body.publisher ? String(body.publisher).trim() : null,
    displayName: String(body.displayName || publicName).trim(),
    lifecycle: body.lifecycle || "active",
    enabled: body.enabled !== false,
    capabilities: body.capabilities && typeof body.capabilities === "object" ? body.capabilities : {},
    limits: body.limits && typeof body.limits === "object" ? body.limits : {},
    policy: body.policy && typeof body.policy === "object" ? body.policy : {},
    sourceUrl: body.sourceUrl ? String(body.sourceUrl).trim() : null,
    verifiedAt: body.verifiedAt ? String(body.verifiedAt).trim() : null,
    catalogVersion: body.catalogVersion ? String(body.catalogVersion).trim() : null,
  };
}

export async function assertStandardModelNameAvailable(publicName, exceptId = null) {
  const existing = await getStandardModelByName(publicName);
  if (existing && existing.id !== exceptId) throw new Error("A standard model with this name already exists");

  const aliases = await getModelAliases();
  if (Object.prototype.hasOwnProperty.call(aliases, publicName)) {
    throw new Error("This name is already used by a legacy model alias");
  }
  if (await getComboByName(publicName)) {
    throw new Error("This name is already used by a combo");
  }
}

export function normalizeBindingInput(body = {}) {
  const providerId = String(body.providerId || body.provider || "").trim();
  if (!providerId) throw new Error("providerId is required");
  const priority = Number(body.priority);
  return {
    providerId,
    enabled: body.enabled !== false,
    priority: Number.isFinite(priority) && priority > 0 ? Math.floor(priority) : 1,
    data: body.data && typeof body.data === "object" ? body.data : {},
  };
}

export function normalizeMappings(mappings) {
  if (!Array.isArray(mappings)) return [];
  return mappings.map((mapping) => ({
    id: mapping.id,
    upstreamModelId: String(mapping.upstreamModelId || mapping.model || "").trim(),
    enabled: mapping.enabled !== false,
    mappingPriority: Number.isFinite(Number(mapping.mappingPriority)) && Number(mapping.mappingPriority) > 0
      ? Math.floor(Number(mapping.mappingPriority)) : 1,
    requestFormats: Array.isArray(mapping.requestFormats) ? mapping.requestFormats.filter(Boolean) : [],
    operations: Array.isArray(mapping.operations) ? mapping.operations.filter(Boolean) : [],
    capabilityOverrides: mapping.capabilityOverrides && typeof mapping.capabilityOverrides === "object"
      ? mapping.capabilityOverrides : {},
  }));
}
