import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const SCOPE = "providerModelCatalog";
const MODEL_KINDS = new Set(["llm", "image", "tts", "stt", "embedding", "imageToText", "video", "music", "webSearch", "webFetch"]);

function catalogKey(providerId, modelId, kind = "llm") {
  return `${providerId}|${modelId}|${kind}`;
}

export function normalizeProviderCatalogModel(rawModel, { providerId, providerAlias, now } = {}) {
  const provider = String(providerId || "").trim();
  const rawId = typeof rawModel === "string"
    ? rawModel
    : rawModel?.id || rawModel?.model || rawModel?.name;
  let modelId = String(rawId || "").trim();
  if (!provider || !modelId) return null;

  for (const prefix of [provider, providerAlias].filter(Boolean)) {
    const value = `${String(prefix).trim()}/`;
    if (modelId.startsWith(value)) {
      modelId = modelId.slice(value.length);
      break;
    }
  }
  if (!modelId) return null;

  const model = typeof rawModel === "object" && rawModel ? rawModel : {};
  const timestamp = now || new Date().toISOString();
  const declaredKind = String(model.kind || model.type || "").trim();
  const kind = MODEL_KINDS.has(declaredKind)
    ? declaredKind
    : "llm";
  const name = String(model.name || model.displayName || model.label || modelId).trim() || modelId;
  const capabilities = model.capabilities || model.caps;

  const alias = String(providerAlias || "").trim();
  return {
    providerId: provider,
    ...(alias ? { providerAlias: alias } : {}),
    modelId,
    kind,
    name,
    ...(capabilities && typeof capabilities === "object" ? { capabilities } : {}),
    ...(model.description ? { description: String(model.description) } : {}),
    ...(Number.isFinite(Number(model.contextLength)) && Number(model.contextLength) > 0
      ? { contextLength: Number(model.contextLength) }
      : {}),
    ...(Number.isFinite(Number(model.maxOutputTokens)) && Number(model.maxOutputTokens) > 0
      ? { maxOutputTokens: Number(model.maxOutputTokens) }
      : {}),
    source: model.source || "discovered",
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    stale: false,
  };
}

function readRows(db) {
  return db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE])
    .map((row) => parseJson(row.value, null))
    .filter((row) => row && row.providerId && row.modelId);
}

export async function getProviderModelCatalog(providerId) {
  const db = await getAdapter();
  const rows = readRows(db);
  return providerId ? rows.filter((row) => row.providerId === providerId) : rows;
}

export async function getProviderModelCatalogs() {
  return getProviderModelCatalog();
}

export async function upsertProviderModelCatalog(providerId, models, options = {}) {
  const provider = String(providerId || "").trim();
  if (!provider || !Array.isArray(models)) return [];

  const db = await getAdapter();
  const now = new Date().toISOString();
  const previousRows = readRows(db).filter((row) => row.providerId === provider);
  const previousByKey = new Map(previousRows.map((row) => [catalogKey(row.providerId, row.modelId, row.kind), row]));
  const seen = new Set();
  const updated = [];

  db.transaction(() => {
    for (const rawModel of models) {
      const incoming = normalizeProviderCatalogModel(rawModel, {
        providerId: provider,
        providerAlias: options.providerAlias,
        now,
      });
      if (!incoming) continue;
      const key = catalogKey(incoming.providerId, incoming.modelId, incoming.kind);
      if (seen.has(key)) continue;
      seen.add(key);
      const previous = previousByKey.get(key);
      const next = {
        ...previous,
        ...incoming,
        source: previous?.source === "discovered" && incoming.source === "static"
          ? previous.source
          : incoming.source,
        firstSeenAt: previous?.firstSeenAt || incoming.firstSeenAt,
        lastSeenAt: now,
        stale: false,
      };
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [SCOPE, key, stringifyJson(next)],
      );
      updated.push(next);
    }

    if (options.markMissingStale !== false) {
      for (const previous of previousRows) {
        const key = catalogKey(previous.providerId, previous.modelId, previous.kind);
        if (seen.has(key)) continue;
        db.run(
          `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
           ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
          [SCOPE, key, stringifyJson({ ...previous, stale: true })],
        );
      }
    }
  });

  return updated;
}

export async function deleteProviderModelCatalog(providerId, modelId, kind = "llm") {
  const db = await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, catalogKey(providerId, modelId, kind)]);
}

export async function clearProviderModelCatalog(providerId) {
  const db = await getAdapter();
  if (!providerId) return;
  db.run(`DELETE FROM kv WHERE scope = ? AND key LIKE ?`, [SCOPE, `${String(providerId).trim()}|%`]);
}

export const MODEL_CATALOG_SCOPE = SCOPE;

// Self-check: discovery refresh must preserve the stable model identity fields.
export function modelCatalogSelfCheck() {
  const model = normalizeProviderCatalogModel({ id: "p/m" }, { providerId: "p", providerAlias: "p", now: "t" });
  return model?.modelId === "m" && model.firstSeenAt === "t" && model.stale === false;
}

if (typeof process !== "undefined" && process.env.NODE_ENV === "test" && !modelCatalogSelfCheck()) {
  throw new Error("provider model catalog self-check failed");
}
