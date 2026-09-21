import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getModelKind } from "@/shared/constants/models";
import {
  AI_PROVIDERS,
  getProviderAlias,
} from "@/shared/constants/providers";
import { getProviderConnections, getCombos, getCustomModels, getModelAliases, getSettings, getStandardModels, getStandardModelBindings, getProviderModelCatalogs } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";
import { resolveQoderModels, routableQoderModels } from "open-sse/services/qoderModels.js";
import { resolveCopilotModels } from "open-sse/services/copilotModels.js";
import { resolveClinepassModels, resolveClineModels } from "open-sse/services/clinepassModels.js";
import { resolveGrokCliModels } from "open-sse/services/grokCliModels.js";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";
import { resolveZedModels } from "open-sse/shared/zedAuth.js";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { getCapabilitiesForModel, normalizeCapabilityOverrides } from "open-sse/providers/capabilities.js";
import { resolveCapabilities } from "@/lib/modelCapabilities";
import { planStandardModelCandidates } from "@/lib/standardModels/planner";
import { isStandardModelHidden } from "@/lib/standardModels/visibility";
import { configuredModelIds, isModelHidden, normalizeModelIds } from "@/lib/modelDiscovery";

// Per-provider live model resolvers. Each receives a connection record and
// returns { models: [{ id, name? }, ...] } | null on failure.
// Adding a provider here makes /v1/models prefer the live catalog for it.
const LIVE_MODEL_RESOLVERS = {
  kiro: async (conn) => {
    const result = await resolveKiroModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  qoder: async (conn) => {
    const result = await resolveQoderModels({
      accessToken: conn.accessToken,
      // PAT (pt-...) connections keep the token in apiKey; without it the live
      // catalog silently fails and /v1/models falls back to the static list.
      apiKey: conn.apiKey,
      refreshToken: conn.refreshToken,
      email: conn.email,
      displayName: conn.displayName,
      providerSpecificData: conn.providerSpecificData || {}
    });
    // Visible + hidden (enable:false) catalog keys — chat routes all of them.
    const models = routableQoderModels(result);
    if (!models.length) return null;
    return { models: models.map((m) => ({ id: m.id, name: m.name })) };
  },
  kimchi: async (conn) => {
    const result = await resolveKimchiModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  github: async (conn) => {
    const result = await resolveCopilotModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, {
      log: console,
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          copilotToken: refreshed.copilotToken,
          copilotTokenExpiresAt: refreshed.copilotTokenExpiresAt,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  clinepass: async (conn) => {
    const result = await resolveClinepassModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cline: async (conn) => {
    const result = await resolveClineModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  "grok-cli": async (conn) => {
    const proxy = await resolveConnectionProxyConfig(conn.providerSpecificData || {});
    const result = await resolveGrokCliModels({
      ...conn,
      connectionId: conn.id,
    }, {
      log: console,
      proxyOptions: {
        connectionProxyEnabled: proxy.connectionProxyEnabled === true,
        connectionProxyUrl: proxy.connectionProxyUrl || "",
        connectionNoProxy: proxy.connectionNoProxy || "",
        vercelRelayUrl: proxy.vercelRelayUrl || "",
        strictProxy: proxy.strictProxy === true,
      },
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          ...refreshed,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cursor: async (conn) => {
    const result = await resolveCursorModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  zed: async (conn) => {
    const result = await resolveZedModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    });
    if (!result?.models?.length) return null;
    return {
      models: result.models
        .filter((m) => !m.isDisabled)
        .map((m) => ({
          id: m.id,
          name: m.name,
          capabilities: m.supportsTools ? { tools: true } : undefined,
        })),
    };
  },
};

// LLM kind sentinel — combos/models with no explicit kind default to LLM
const LLM_KIND = "llm";

// Map per-model `type` field (in PROVIDER_MODELS) to service kind.
// Models without `type` are treated as LLM.
const MODEL_TYPE_TO_KIND = {
  image: "image",
  tts: "tts",
  embedding: "embedding",
  stt: "stt",
  imageToText: "imageToText",
  video: "video",
};

function modelKind(model) {
  const k = model?.kind || model?.type;
  if (!k) return LLM_KIND;
  return MODEL_TYPE_TO_KIND[k] || LLM_KIND;
}

// For dynamic/unknown model IDs (compatible providers, alias map, custom models)
// fall back to provider-level kind matching when per-model type is unavailable.
function inferKindFromUnknownModelId(modelId) {
  const lower = String(modelId).toLowerCase();
  if (/embed/.test(lower)) return "embedding";
  if (/tts|speech|audio|voice/.test(lower)) return "tts";
  if (/image|imagen|dall-?e|flux|sdxl|sd-|stable-diffusion/.test(lower)) return "image";
  return LLM_KIND;
}

function standardModelKind(model, capabilities) {
  const values = [model?.publicName, model?.officialModelId, model?.displayName]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (capabilities?.image === true
    || capabilities?.imageGeneration === true
    || capabilities?.imageEdit === true
    || capabilities?.imageOutput === true
    || capabilities?.text2img === true
    || capabilities?.edit === true
    || /image|imagen|dall-?e|flux|stable-diffusion|sdxl/.test(values)) {
    return "image";
  }
  return LLM_KIND;
}

// DSH and several OpenAI-compatible clients use modality metadata when
// deciding whether to preserve uploaded images. Keep the existing capabilities
// object for 9router consumers, and expose the equivalent input list in both
// common spellings without changing model ids or routing behavior.
function inputModalitiesFromCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== "object") return null;
  const modalities = ["text"];
  if (capabilities.vision === true) modalities.push("image");
  if (capabilities.pdf === true) modalities.push("pdf");
  if (capabilities.audioInput === true) modalities.push("audio");
  if (capabilities.videoInput === true) modalities.push("video");
  return modalities;
}

function attachInputModalities(model, capabilities) {
  const modalities = inputModalitiesFromCapabilities(capabilities);
  if (!modalities) return model;
  model.input_modalities = modalities;
  model.inputModalities = modalities;
  // llm-pi-ai/DSH model definitions use `input`, while some compatible
  // clients use the nested OpenCode-style `modalities.input`. Keep all of the
  // aliases in the discovery response; unknown OpenAI model fields are
  // ignored by standard clients and this avoids a false text-only fallback.
  model.input = modalities;
  model.modalities = {
    ...(model.modalities && typeof model.modalities === "object" && !Array.isArray(model.modalities) ? model.modalities : {}),
    input: modalities,
  };
  return model;
}

// Provider matches kindFilter when its serviceKinds intersect the requested kinds.
// LLM is the default kind for providers missing serviceKinds.
function providerMatchesKinds(providerId, kindFilter) {
  const provider = AI_PROVIDERS[providerId];
  const kinds = Array.isArray(provider?.serviceKinds) && provider.serviceKinds.length > 0
    ? provider.serviceKinds
    : [LLM_KIND];
  return kindFilter.some((k) => kinds.includes(k));
}

// Combo matches kindFilter when its `kind` field is in the list.
// Combos with no kind are treated as LLM.
function comboMatchesKinds(combo, kindFilter) {
  const kind = combo?.kind || LLM_KIND;
  return kindFilter.includes(kind);
}

function providerModelIsImageCapable(providerId, upstreamModelId) {
  const providerAliases = [providerId, PROVIDER_ID_TO_ALIAS[providerId]].filter(Boolean);
  const catalogModel = providerAliases
    .flatMap((alias) => PROVIDER_MODELS[alias] || [])
    .find((model) => model?.id === upstreamModelId);
  if (catalogModel?.kind === "image" || catalogModel?.type === "image") return true;
  return getCapabilitiesForModel(providerId, upstreamModelId).imageOutput === true;
}

async function standardModelHasImageCapability(standardModel, standardCapabilities) {
  const declared = standardModel?.capabilities?.imageOutput;
  if (typeof declared === "boolean") return declared;
  if (standardCapabilities?.imageOutput === true) return true;

  try {
    const bindings = await getStandardModelBindings(standardModel.id);
    const plan = planStandardModelCandidates({
      model: standardModel,
      bindings,
      requestFormat: "openai-images",
      // Discovery accepts mappings that explicitly serve either generation or
      // edit; the request handler applies the concrete operation at runtime.
      operation: null,
      requireConfiguredProvider: true,
    });
    return plan.candidates.some((candidate) => providerModelIsImageCapable(candidate.providerId, candidate.upstreamModelId));
  } catch {
    return false;
  }
}

/**
 * Build OpenAI-format models list filtered by service kinds.
 * @param {string[]} kindFilter - List of service kinds to include (e.g. ["llm"], ["webSearch","webFetch"]).
 */
export async function buildModelsList(kindFilter) {
  let connections = [];
  let connectionsLoadFailed = false;
  try {
    connections = await getProviderConnections();
    connections = connections.filter(c => c.isActive !== false);
  } catch (e) {
    connectionsLoadFailed = true;
    console.log("Could not fetch providers; provider discovery is unavailable");
  }

  let combos = [];
  try {
    combos = await getCombos();
  } catch (e) {
    console.log("Could not fetch combos");
  }

  let customModels = [];
  try {
    customModels = await getCustomModels();
  } catch (e) {
    console.log("Could not fetch custom models");
  }

  let providerModelCatalog = [];
  try {
    providerModelCatalog = await getProviderModelCatalogs();
  } catch (e) {
    console.log("Could not fetch provider model catalog");
  }

  let modelAliases = {};
  try {
    modelAliases = await getModelAliases();
  } catch (e) {
    console.log("Could not fetch model aliases");
  }

  let disabledByAlias = {};
  try {
    disabledByAlias = await getDisabledModels();
  } catch (e) {
    console.log("Could not fetch disabled models");
  }
  const isDisabled = (...args) => {
    const modelId = args.pop();
    return args.some(
      (alias) =>
        Array.isArray(disabledByAlias[alias]) &&
        disabledByAlias[alias].includes(modelId),
    );
  };

  const activeConnectionByProvider = new Map();
  for (const conn of connections) {
    if (!activeConnectionByProvider.has(conn.provider)) {
      activeConnectionByProvider.set(conn.provider, conn);
    }
  }

  const models = [];

  // When unified routing is enabled, advertise registered standard names in
  // addition to the existing provider-prefixed catalog. Provider-prefixed
  // entries remain available by default for backwards compatibility.
  let standardModels = [];
  try {
    const settings = await getSettings();
    if (settings.standardModelRouting?.enabled === true && settings.standardModelRouting?.modelListMode !== "provider-only") {
      standardModels = await getStandardModels({ includeDisabled: false });
    }
  } catch (error) {
    console.log("Could not fetch standard models", error);
  }

  // Combos first (filtered by kind). Web combos expose `kind` so AI knows search vs fetch.
  for (const combo of combos) {
    if (!comboMatchesKinds(combo, kindFilter)) continue;
    if (isModelHidden(disabledByAlias, ["combo"], combo.name)) continue;
    const entry = {
      id: combo.name,
      object: "model",
      owned_by: "combo",
    };
    if (combo.kind === "webSearch" || combo.kind === "webFetch") {
      entry.kind = combo.kind;
    }
    models.push(entry);
  }

  if (connectionsLoadFailed) {
    // A database error must not fail open into the entire built-in catalog.
  } else if (connections.length === 0) {
    // Only no-auth system providers are configured without a connection.
    const aliasToProviderId = Object.fromEntries(
      Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])
    );
    for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS)) {
      const providerId = aliasToProviderId[alias] || alias;
      if (!AI_PROVIDERS[providerId]?.noAuth) continue;
      if (!providerMatchesKinds(providerId, kindFilter)) continue;
      for (const model of providerModels) {
        if (!kindFilter.includes(modelKind(model))) continue;
        if (isDisabled(alias, providerId, model.id)) continue;
        models.push({
          id: `${alias}/${model.id}`,
          object: "model",
          owned_by: alias,
        });
      }
    }

  } else {
    for (const [providerId, conn] of activeConnectionByProvider.entries()) {
      if (!providerMatchesKinds(providerId, kindFilter)) continue;

      const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const outputAlias = (
        conn?.providerSpecificData?.prefix
        || getProviderAlias(providerId)
        || staticAlias
      ).trim();
      const providerModels = PROVIDER_MODELS[staticAlias] || [];
      const catalogModels = providerModelCatalog.filter((model) => model.providerId === providerId && model.stale !== true);
      const enabledModels = conn?.providerSpecificData?.enabledModels;
      const hasExplicitEnabledModels = Array.isArray(enabledModels);

      // Build kind lookup for static models so we can filter even when only IDs are exposed
      const catalogModelById = new Map(catalogModels.map((m) => [m.modelId, m]));
      const staticModelKindById = new Map(
        providerModels.map((m) => [m.id, modelKind(m)])
      );
      let liveModelKindById = new Map();
      let liveCapabilitiesById = new Map();

      let rawModelIds = hasExplicitEnabledModels
        ? normalizeModelIds(enabledModels)
        : normalizeModelIds([
          ...providerModels.map((model) => model.id),
          ...catalogModels.map((model) => model.modelId),
        ]);

      // Config-driven live catalog override (e.g. Kiro returns dynamic
      // -thinking/-agentic variants per account). On failure, fall back to
      // whatever rawModelIds already holds.
      const liveResolver = LIVE_MODEL_RESOLVERS[providerId];
      if (liveResolver && !hasExplicitEnabledModels) {
        try {
          const live = await liveResolver(conn);
          if (live?.models?.length) {
            rawModelIds = live.models.map((m) => m.id);
            liveModelKindById = new Map(
              live.models
                .filter((m) => m?.id)
                .map((m) => [m.id, modelKind(m)])
            );
            liveCapabilitiesById = new Map(
              live.models
                .filter((m) => m?.id && m.capabilities)
                .map((m) => [m.id, m.capabilities])
            );
          }
        } catch (err) {
          console.log(`Live model fetch failed for ${providerId}: ${err?.message || err}`);
        }
      }

      const modelIds = rawModelIds
        .map((modelId) => {
          if (modelId.startsWith(`${outputAlias}/`)) {
            return modelId.slice(outputAlias.length + 1);
          }
          if (modelId.startsWith(`${staticAlias}/`)) {
            return modelId.slice(staticAlias.length + 1);
          }
          if (modelId.startsWith(`${providerId}/`)) {
            return modelId.slice(providerId.length + 1);
          }
          return modelId;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const customModelKindById = new Map();
      const customModelCapabilitiesById = new Map();
      const customModelIds = customModels
        .filter((m) => {
          if (!m?.id) return false;
          const kind = getModelKind(m) || LLM_KIND;
          // imageToText custom models are vision-capable chat models: expose them
          // both in the default LLM list and in /v1/models/image-to-text.
          if (!kindFilter.includes(kind) && !(kind === "imageToText" && kindFilter.includes(LLM_KIND))) return false;
          const alias = m.providerAlias;
          return alias === staticAlias || alias === outputAlias || alias === providerId;
        })
        .map((m) => {
          const modelId = String(m.id).trim();
          if (modelId) {
            customModelKindById.set(modelId, getModelKind(m) || LLM_KIND);
            const caps = normalizeCapabilityOverrides(m.caps);
            if (Object.keys(caps).length > 0) customModelCapabilitiesById.set(modelId, caps);
          }
          return modelId;
        })
        .filter((modelId) => modelId !== "");

      const aliasModelIds = Object.values(modelAliases || {})
        .filter((fullModel) => {
          if (typeof fullModel !== "string" || !fullModel.includes("/")) return false;
          return (
            fullModel.startsWith(`${outputAlias}/`) ||
            fullModel.startsWith(`${staticAlias}/`) ||
            fullModel.startsWith(`${providerId}/`)
          );
        })
        .map((fullModel) => {
          if (fullModel.startsWith(`${outputAlias}/`)) {
            return fullModel.slice(outputAlias.length + 1);
          }
          if (fullModel.startsWith(`${staticAlias}/`)) {
            return fullModel.slice(staticAlias.length + 1);
          }
          if (fullModel.startsWith(`${providerId}/`)) {
            return fullModel.slice(providerId.length + 1);
          }
          return fullModel;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const catalogModelIds = catalogModels.map((model) => model.modelId);
      const mergedModelIds = configuredModelIds({
        connection: conn,
        staticModelIds: [...modelIds, ...catalogModelIds],
        customModelIds,
        aliasModelIds,
      });

      for (const modelId of mergedModelIds) {
        // Resolve kind: prefer custom/live metadata, then static, then ID heuristics.
        const customKind = customModelKindById.get(modelId);
        const liveKind = liveModelKindById.get(modelId);
        const catalogModel = catalogModelById.get(modelId);
        const kind = customKind || liveKind || catalogModel?.kind || staticModelKindById.get(modelId) || inferKindFromUnknownModelId(modelId);
        // imageToText custom models stay in the LLM list (vision-capable chat models)
        const allowAsLlm = kind === "imageToText" && kindFilter.includes(LLM_KIND);
        if (!kindFilter.includes(kind) && !allowAsLlm) continue;
        if (isDisabled(outputAlias, modelId) || isDisabled(staticAlias, modelId)) continue;

        const model = {
          id: `${outputAlias}/${modelId}`,
          object: "model",
          owned_by: outputAlias,
        };
        // Live-catalog resolvers (kiro/qoder/github/clinepass) mostly only return
        // { id, name } — no per-model capability data. Feed every layer through
        // the shared resolver so the advertised capabilities match what the
        // request runtime strips/forwards for the same model. A custom model's
        // stored capabilities (and service kind) apply only to its own entry;
        // models without overrides keep the historical live/static result.
        const liveCaps = liveCapabilitiesById.get(modelId) || null;
        const serviceKind = customKind || liveKind || null;
        const catalogCaps = catalogModel?.capabilities || null;
        const customCaps = customModelCapabilitiesById.get(modelId) || null;
        // Preserve the historical shape: only attach a capabilities block where
        // there is a runtime-capable kind (LLM) or a media kind was declared by
        // a custom model / live catalog.
        const shouldAttachCaps = kind === LLM_KIND || allowAsLlm || !!serviceKind || !!liveCaps;
        const caps = shouldAttachCaps
          ? resolveCapabilities({
            provider: providerId,
            model: modelId,
            serviceKind,
            liveCapabilities: liveCaps,
            persisted: { ...(catalogCaps || {}), ...(customCaps || {}) },
          })
          : null;
        if (caps) {
          model.capabilities = caps;
          attachInputModalities(model, caps);
        }
        // Token limits under the snake_case names the OpenAI/OpenRouter
        // convention uses. `capabilities.contextWindow` is camelCase and nested,
        // so clients matching context_length find nothing, fall back to guessing
        // the window from the model name, and guess high — a 372k model read as
        // 1.05M never reaches its compaction threshold and hard-fails upstream.
        // Emitted at top level because not every client recurses into nested
        // objects; the camelCase `capabilities` block stays for compatibility.
        if (kind === LLM_KIND || allowAsLlm) {
          let contextWindow = caps?.contextWindow;
          let maxOutput = caps?.maxOutput;
          // Live-catalog and service-kind capabilities are usually partial
          // (often just { tools: true }), so fill the gaps from the static
          // table rather than emitting null and leaving clients to guess.
          if (!Number.isFinite(contextWindow) || !Number.isFinite(maxOutput)) {
            const fallback = getCapabilitiesForModel(providerId, modelId);
            if (!Number.isFinite(contextWindow)) contextWindow = fallback.contextWindow;
            if (!Number.isFinite(maxOutput)) maxOutput = fallback.maxOutput;
          }
          if (Number.isFinite(contextWindow)) model.context_length = contextWindow;
          if (Number.isFinite(maxOutput)) model.max_completion_tokens = maxOutput;
        }
        models.push(model);
      }

      // Web search/fetch — provider IS the model, expose as {alias}/search and/or {alias}/fetch with explicit kind
      const providerInfo = AI_PROVIDERS[providerId];
      if (kindFilter.includes("webSearch") && providerInfo?.searchConfig) {
        models.push({
          id: `${outputAlias}/search`,
          object: "model",
          kind: "webSearch",
          owned_by: outputAlias,
        });
      }
      if (kindFilter.includes("webFetch") && providerInfo?.fetchConfig) {
        models.push({
          id: `${outputAlias}/fetch`,
          object: "model",
          kind: "webFetch",
          owned_by: outputAlias,
        });
      }
    }
  }

  for (const standardModel of standardModels) {
    if (!standardModel?.publicName || standardModel.enabledProviderCount < 1) continue;
    if (isStandardModelHidden(disabledByAlias, standardModel.publicName)) continue;
    // Resolve through the same aggregation the request runtime uses. The
    // bundled authoritative catalog fills any gap the local registration
    // leaves, but a local record only overrides the fields it actually
    // declares: a partial object such as { tools: true } must not mask the
    // catalog's `vision`, while an explicit { vision: false } must survive.
    // Older local registrations may have an empty capabilities JSON object, so
    // a stale/partially migrated DB cannot make a known vision model look
    // text-only to DSH or another capability-aware client.
    const localCapabilities = standardModel.capabilities && typeof standardModel.capabilities === "object"
      ? standardModel.capabilities
      : {};
    let standardCapabilities = resolveCapabilities({
      provider: "",
      model: standardModel.officialModelId || standardModel.publicName,
      publicName: standardModel.publicName,
      persisted: localCapabilities,
    });
    const standardKind = standardModelKind(standardModel, standardCapabilities);
    const hasImageCapability = await standardModelHasImageCapability(standardModel, standardCapabilities);
    if (hasImageCapability && standardCapabilities.imageOutput !== true) {
      standardCapabilities = { ...standardCapabilities, imageOutput: true };
    }
    if (kindFilter.includes("image") && !hasImageCapability) continue;
    // The default /v1/models catalog includes enabled standard image models so
    // clients that only discover the root endpoint can use them. Capability
    // scoped catalogs still return only their requested kind.
    if (!kindFilter.includes(standardKind) && !(standardKind === "image" && kindFilter.includes(LLM_KIND))) continue;
    const entry = {
      id: standardModel.publicName,
      object: "model",
      owned_by: standardModel.publisher || "9router",
      standard_model: true,
      root: standardModel.officialModelId,
      kind: standardKind,
    };
    if (standardKind === "image") entry.endpoint = "/v1/images/generations";
    entry.capabilities = standardCapabilities;
    attachInputModalities(entry, standardCapabilities);
    if (Number.isFinite(Number(standardModel.limits?.contextWindow))) {
      entry.context_length = Number(standardModel.limits.contextWindow);
    }
    if (Number.isFinite(Number(standardModel.limits?.maxOutput))) {
      entry.max_completion_tokens = Number(standardModel.limits.maxOutput);
    }
    models.push(entry);
  }

  const dedupedModels = [];
  const seenModelIds = new Set();
  for (const model of models) {
    if (!model?.id || seenModelIds.has(model.id)) continue;
    seenModelIds.add(model.id);
    dedupedModels.push(model);
  }

  return dedupedModels;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list (LLM/chat models only by default).
 * For other capabilities use /v1/models/{kind} (image, tts, stt, embedding, image-to-text, web).
 */
export async function GET() {
  try {
    const data = await buildModelsList([LLM_KIND]);
    return Response.json({ object: "list", data }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
