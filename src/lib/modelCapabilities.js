// Request-time capability resolution for locally registered models.
//
// The static capability registry lives in open-sse and is also bundled for the
// browser. Database-backed model metadata must stay in the server layer, so
// this module loads persisted overrides once per incoming chat request and
// exposes a small synchronous resolver for the downstream routing code.
//
// Both the request runtime (open-sse/handlers/chatCore.js via the resolver) and
// the discovery layer (/v1/models) funnel their capability inputs through
// `resolveCapabilities()` so the two cannot drift apart.

import { getCustomModels } from "@/lib/localDb";
import { resolveProviderId } from "@/shared/constants/providers";
import { findBundledStandardModel } from "@/lib/standardModels/catalog";
import {
  capabilitiesFromServiceKind,
  getCapabilitiesForModel,
  mergeCapabilities,
  normalizeCapabilityOverrides,
} from "open-sse/providers/capabilities.js";

function normalizeProvider(provider) {
  const value = String(provider || "").trim();
  return value ? resolveProviderId(value) : "";
}

function capabilityKey(provider, model) {
  return `${normalizeProvider(provider)}\u0000${String(model || "").trim()}`;
}

function serviceKindOf(row) {
  const kind = row?.kind || row?.type;
  return typeof kind === "string" && kind.trim() ? kind.trim() : null;
}

/**
 * Single aggregation point for capability inputs. Both the request runtime and
 * the /v1/models discovery response call this; every input layer below the
 * static table is normalised through `normalizeCapabilityOverrides`, so no
 * persisted or catalog field can leak an unrecognised key into the runtime.
 *
 * Priority (low → high, later layers win field by field):
 *   1. getCapabilitiesForModel(provider, model)          static table / name rules
 *   2. capabilitiesFromServiceKind(serviceKind)          custom-model service kind
 *      liveCapabilities                                   provider live /models metadata
 *   3. findBundledStandardModel(publicName)?.capabilities bundled standard catalog
 *   4. persisted                                          local DB (standard declared / custom caps)
 *   5. overrides                                          explicit mapping.capabilityOverrides
 *
 * The function is pure and synchronous: callers pass values they already
 * loaded, so no DB or file I/O happens here.
 */
export function resolveCapabilities({
  provider = "",
  model = "",
  serviceKind = null,
  liveCapabilities = null,
  publicName = null,
  persisted = null,
  overrides = null,
} = {}) {
  const base = getCapabilitiesForModel(provider, model);
  const catalog = publicName ? findBundledStandardModel(publicName)?.capabilities : null;
  return mergeCapabilities(
    base,
    capabilitiesFromServiceKind(serviceKind),
    liveCapabilities,
    catalog,
    persisted,
    overrides,
  );
}

/**
 * Load all persisted custom-model capability metadata into a request-local map.
 * The map is intentionally rebuilt per chat request so edits take effect
 * immediately and no long-lived cache can serve stale or cross-request data.
 *
 * Each entry stores the normalised capability overrides and the dashboard
 * service kind, so the runtime can apply the same service-kind derivation the
 * discovery layer uses even for custom models with no explicit caps.
 */
export async function loadCustomModelCapabilityOverrides() {
  const overrides = new Map();
  let rows = [];
  try {
    rows = await getCustomModels();
  } catch {
    // Capability metadata is an enhancement. If the local DB is unavailable,
    // callers continue with the static resolver rather than making chat fail.
    return overrides;
  }

  for (const row of rows || []) {
    const provider = String(row?.providerAlias || "").trim();
    const model = String(row?.id || "").trim();
    if (!provider || !model) continue;

    const clean = normalizeCapabilityOverrides(row?.caps);
    const serviceKind = serviceKindOf(row);
    if (Object.keys(clean).length === 0 && !serviceKind) continue;

    const key = capabilityKey(provider, model);
    const existing = overrides.get(key) || {};
    overrides.set(key, {
      caps: { ...(existing.caps || {}), ...clean },
      serviceKind: serviceKind || existing.serviceKind || null,
    });
  }

  return overrides;
}

/**
 * Create a synchronous resolver suitable for open-sse's hot-path helpers.
 * `customOverrides` is the map produced by `loadCustomModelCapabilityOverrides`.
 *
 * The optional third argument is a request-scoped context:
 *   { publicName?, persisted?, overrides?, serviceKind?, liveCapabilities? }
 * It carries the standard-model identity and any mapping-level overrides for
 * one route candidate, which is how standard-model metadata stays isolated.
 */
export function createCapabilityResolver(customOverrides = new Map()) {
  return (provider, model, context = null) => {
    const entry = customOverrides.get(capabilityKey(provider, model));
    return resolveCapabilities({
      provider,
      model,
      serviceKind: context?.serviceKind ?? entry?.serviceKind ?? null,
      liveCapabilities: context?.liveCapabilities ?? null,
      publicName: context?.publicName ?? null,
      persisted: {
        ...(entry?.caps || {}),
        ...(context?.persisted || {}),
      },
      overrides: context?.overrides ?? null,
    });
  };
}
