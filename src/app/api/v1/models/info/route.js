import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { AI_PROVIDERS, ALIAS_TO_ID } from "@/shared/constants/providers";
import { getModelKind } from "@/shared/constants/models";
import { buildModelsList } from "@/app/api/v1/models/route";

const KIND_ENDPOINT = {
  llm: "/v1/chat/completions",
  image: "/v1/images/generations",
  tts: "/v1/audio/speech",
  stt: "/v1/audio/transcriptions",
  embedding: "/v1/embeddings",
  imageToText: "/v1/chat/completions",
  webSearch: "/v1/search",
  webFetch: "/v1/fetch",
};

const TTS_VOICES_API = new Set(["elevenlabs", "edge-tts", "deepgram", "inworld", "local-device"]);

function buildInfo({ alias, providerId, model, kind, providerInfo }) {
  const out = {
    id: `${alias}/${model.id}`,
    name: model.name || model.id,
    kind,
    owned_by: alias,
    endpoint: KIND_ENDPOINT[kind] || null,
  };
  if (model.params) out.params = model.params;
  if (model.capabilities) out.capabilities = model.capabilities;
  if (model.options) out.options = model.options;
  if (model.dimensions) out.dimensions = model.dimensions;
  if (model.contextWindow) out.contextWindow = model.contextWindow;
  if (kind === "tts" && TTS_VOICES_API.has(providerId)) {
    out.voicesUrl = `/v1/audio/voices?provider=${providerId}`;
  }
  if (kind === "webSearch" && providerInfo?.searchConfig) {
    const cfg = providerInfo.searchConfig;
    if (cfg.searchTypes) out.searchTypes = cfg.searchTypes;
    if (cfg.maxMaxResults) out.maxResults = cfg.maxMaxResults;
    if (cfg.requiredOptions) out.required = cfg.requiredOptions;
  }
  return out;
}

// id format: "{alias}/{modelId}" - alias may also be providerId
// requestedKind: optional, disambiguates duplicate ids across kinds (e.g. gemini-2.5-pro llm vs stt)
function lookup(fullId, requestedKind) {
  if (!fullId || !fullId.includes("/")) return null;
  const slash = fullId.indexOf("/");
  const alias = fullId.slice(0, slash);
  const modelId = fullId.slice(slash + 1);
  const providerId = ALIAS_TO_ID[alias] || alias;
  const providerInfo = AI_PROVIDERS[providerId];

  // PROVIDER_MODELS lookup (by alias key, fallback to providerId)
  const list = PROVIDER_MODELS[alias] || PROVIDER_MODELS[providerId] || [];
  const m = requestedKind
    ? list.find((x) => x.id === modelId && getModelKind(x, "llm") === requestedKind)
    : list.find((x) => x.id === modelId);
  if (m) {
    const kind = getModelKind(m, "llm");
    return buildInfo({ alias, providerId, model: m, kind, providerInfo });
  }

  // Web search/fetch — virtual model id "search" / "fetch"
  if (modelId === "search" && providerInfo?.searchConfig) {
    return buildInfo({
      alias, providerId, kind: "webSearch", providerInfo,
      model: { id: "search", name: `${providerInfo.name} Search`, params: ["query", "max_results", "country", "language", "time_range", "domain_filter", "search_type"] },
    });
  }
  if (modelId === "fetch" && providerInfo?.fetchConfig) {
    return buildInfo({
      alias, providerId, kind: "webFetch", providerInfo,
      model: { id: "fetch", name: `${providerInfo.name} Fetch`, params: ["url", "format", "max_characters"] },
    });
  }
  return null;
}

// Info derived from a discovery entry — the fallback for models that only
// exist in dynamic catalogs (live resolvers, custom models, enabledModels
// allowlists), which the static PROVIDER_MODELS lookup() cannot see.
function buildDiscoveryInfo(entry, fallbackKind) {
  const kind = entry.kind || fallbackKind || "llm";
  const out = {
    id: entry.id,
    name: entry.id,
    kind,
    owned_by: entry.owned_by || null,
    endpoint: entry.endpoint || KIND_ENDPOINT[kind] || null,
  };
  if (entry.capabilities) out.capabilities = entry.capabilities;
  if (Number.isFinite(Number(entry.context_length))) out.contextWindow = Number(entry.context_length);
  if (Number.isFinite(Number(entry.max_completion_tokens))) out.maxOutputTokens = Number(entry.max_completion_tokens);
  return out;
}

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

// GET /v1/models/info?id={alias}/{modelId} — metadata for a single model
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const kind = searchParams.get("kind");
  if (!id) {
    return Response.json(
      { error: { message: "Missing required query param: id (e.g. ?id=openai/dall-e-3)", type: "invalid_request_error" } },
      { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
  const requestedKind = kind === "chat" ? "llm" : kind;

  // Static metadata first (params/voices/search config that discovery does not
  // carry). Knowing the model's kind lets the visibility check run for ONE
  // kind instead of every kind, avoiding serial live resolvers per kind.
  const staticInfo = lookup(id, requestedKind);
  let discovered;
  if (staticInfo) {
    discovered = await buildModelsList([staticInfo.kind]);
  } else if (requestedKind) {
    discovered = await buildModelsList([requestedKind]);
  } else {
    // Kind unknown: the LLM-root view matches almost everything; only fall
    // back to the full kind sweep for image/tts/... models. (The full sweep
    // alone would miss standard LLM models — buildModelsList filters
    // non-image standard models whenever "image" is part of the query.)
    discovered = await buildModelsList(["llm"]);
    if (!discovered.some((model) => model?.id === id)) {
      discovered = await buildModelsList(["llm", "image", "tts", "stt", "embedding", "imageToText", "video", "music", "webSearch", "webFetch"]);
    }
  }
  if (!discovered.some((model) => model?.id === id)) {
    return Response.json(
      { error: { message: `Model not found: ${id}`, type: "not_found" } },
      { status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }

  // Visible per discovery: prefer the static metadata when available, else
  // build from the discovery entry so dynamic models do not 404 here.
  const info = staticInfo || buildDiscoveryInfo(discovered.find((model) => model?.id === id), requestedKind);
  return Response.json(info, { headers: { "Access-Control-Allow-Origin": "*" } });
}
