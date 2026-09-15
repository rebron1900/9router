import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envRequestLogs = process.env.ENABLE_REQUEST_LOGS;
    if (envRequestLogs !== undefined) {
      const enabled = envRequestLogs.toLowerCase() === "true";
      cachedConfig = {
        enabled,
        maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
        batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
        flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
        maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
      };
      cachedConfigTs = Date.now();
      return cachedConfig;
    }
    const envFallback = process.env.OBSERVABILITY_ENABLED !== "false";
    const uiFlag = typeof settings.enableObservability === "boolean";
    const enabled = uiFlag
      ? settings.enableObservability
      : envFallback;

    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

export const __test__ = { sanitizeHeaders };

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function appendStatusFilter(conditions, params, status) {
  if (!status) return;
  const normalized = String(status).toLowerCase();
  const values = normalized === "success" || normalized === "ok"
    ? ["success", "ok"]
    : normalized === "error" || normalized === "failed"
      ? ["error", "failed"]
      : [status];
  conditions.push(values.length === 1 ? "status = ?" : `status IN (${values.map(() => "?").join(", ")})`);
  params.push(...values);
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
  }
  return obj || {};
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      const items = writeBuffer.splice(0, writeBuffer.length);
      const db = await getAdapter();
      const config = await getObservabilityConfig();

      db.transaction(() => {
        for (const item of items) {
          if (!item.id) item.id = generateDetailId(item.model);
          if (!item.timestamp) item.timestamp = new Date().toISOString();
          if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

          const record = {
            id: item.id,
            requestId: item.requestId || null,
            provider: item.provider || null,
            model: item.model || null,
            connectionId: item.connectionId || null,
            timestamp: item.timestamp,
            status: item.status || null,
            latency: item.latency || {},
            tokens: item.tokens || {},
            request: truncateField(item.request, config.maxJsonSize),
            providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
            providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
            response: truncateField(item.response, config.maxJsonSize),
            pxpipe: item.pxpipe || undefined,
          };

          db.run(
            `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data`,
            [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.status, stringifyJson(record)]
          );
        }

        const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
        if (cnt && cnt.c > config.maxRecords) {
          db.run(
            `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
            [cnt.c - config.maxRecords]
          );
        }
      });
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) {return;}

  writeBuffer.push(detail);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const offset = (page - 1) * pageSize;

  // Observability is optional, but Usage > Details must still expose newer
  // durable usage rows. Keep filtering, ordering, deduplication, counting and
  // pagination in SQLite: materialising both unbounded tables here made every
  // page request O(all history) in memory and CPU.
  const detailConds = [];
  const detailParams = [];
  const historyConds = [];
  const historyParams = [];
  const addCommonFilters = (conds, params) => {
    if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
    if (filter.model) { conds.push("model LIKE ?"); params.push(`%${filter.model}%`); }
    if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
    appendStatusFilter(conds, params, filter.status);
    if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
    if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }
  };
  addCommonFilters(detailConds, detailParams);
  addCommonFilters(historyConds, historyParams);

  const detailWhere = detailConds.length ? `WHERE ${detailConds.join(" AND ")}` : "";
  const historyWhere = historyConds.length ? `WHERE ${historyConds.join(" AND ")}` : "";
  const mergedCte = `
    WITH details_source AS (
      SELECT
        0 AS source_order,
        id AS sort_id,
        timestamp,
        data,
        NULL AS history_id,
        provider,
        model,
        connectionId,
        status,
        NULL AS endpoint,
        NULL AS promptTokens,
        NULL AS completionTokens,
        NULL AS cost,
        NULL AS tokens,
        CASE WHEN json_valid(data) THEN json_extract(data, '$.requestId') END AS request_key
      FROM requestDetails
      ${detailWhere}
    ),
    history_source AS (
      SELECT
        1 AS source_order,
        CAST(id AS TEXT) AS sort_id,
        timestamp,
        NULL AS data,
        id AS history_id,
        provider,
        model,
        connectionId,
        status,
        endpoint,
        promptTokens,
        completionTokens,
        cost,
        tokens,
        CASE WHEN json_valid(meta) THEN json_extract(meta, '$.requestId') END AS request_key
      FROM usageHistory
      ${historyWhere}
    ),
    history_without_reliable_duplicate AS (
      SELECT h.*
      FROM history_source h
      WHERE h.request_key IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM details_source d
           WHERE d.request_key IS NOT NULL
             AND d.request_key = h.request_key
         )
    ),
    merged AS (
      SELECT * FROM details_source
      UNION ALL
      SELECT * FROM history_without_reliable_duplicate
    )
  `;
  const queryParams = [...detailParams, ...historyParams];
  const count = db.get(
    `${mergedCte}
     SELECT COUNT(*) AS totalItems,
            SUM(CASE WHEN source_order = 0 THEN 1 ELSE 0 END) AS detailItems,
            SUM(CASE WHEN source_order = 1 THEN 1 ELSE 0 END) AS historyItems
       FROM merged`,
    queryParams,
  ) || {};
  const totalItems = Number(count.totalItems) || 0;
  const rows = db.all(
    `${mergedCte}
     SELECT source_order, sort_id, timestamp, data, history_id, provider, model,
            connectionId, status, endpoint, promptTokens, completionTokens, cost, tokens
       FROM merged
      ORDER BY timestamp DESC, source_order ASC, sort_id DESC
      LIMIT ? OFFSET ?`,
    [...queryParams, pageSize, offset],
  );

  const details = rows.map((row) => {
    if (Number(row.source_order) === 0) {
      const item = parseJson(row.data, {});
      // Keep corrupt rows as the historical {} fallback so the details drawer
      // remains crash-safe; valid rows are explicitly source-labelled.
      if (item && typeof item === "object" && Object.keys(item).length > 0) item.source ||= "requestDetails";
      return item;
    }
    const tokens = parseJson(row.tokens, {}) || {};
    if (tokens.prompt_tokens === undefined && tokens.input_tokens === undefined) {
      tokens.prompt_tokens = row.promptTokens || 0;
    }
    if (tokens.completion_tokens === undefined && tokens.output_tokens === undefined) {
      tokens.completion_tokens = row.completionTokens || 0;
    }
    return {
      id: `usage-${row.history_id}`,
      timestamp: row.timestamp,
      provider: row.provider,
      model: row.model,
      connectionId: row.connectionId,
      status: row.status || "ok",
      endpoint: row.endpoint || null,
      cost: row.cost || 0,
      latency: { ttft: 0, total: 0 },
      tokens,
      request: { redacted: true },
      response: { redacted: true },
      source: "usageHistory",
    };
  });
  const source = Number(count.detailItems) > 0 && Number(count.historyItems) > 0
    ? "merged"
    : (Number(count.historyItems) > 0 ? "usageHistory" : "requestDetails");
  const totalPages = Math.ceil(totalItems / pageSize);

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
    source,
  };
}

export async function getDistinctProviders() {
  const db = await getAdapter();
  const rows = db.all(`
    SELECT provider FROM requestDetails WHERE provider IS NOT NULL
    UNION
    SELECT provider FROM usageHistory WHERE provider IS NOT NULL
    ORDER BY provider ASC
  `);
  return rows.map((r) => r.provider);
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

// HMR re-evaluates this module and creates a NEW handler identity each time;
// process.off() with the new reference cannot remove the previous module's
// listeners, so beforeExit/SIGINT/SIGTERM/exit handlers accumulated four per
// reload (each stale one still flushing an orphaned buffer). Keep the live
// handler in a global registry so every reload removes the previous one first.
const shutdownRegistry = (globalThis.__requestDetailsShutdownHandlers ??= new Set());

function makeShutdownHandler() {
  return async () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (writeBuffer.length > 0) await flushToDatabase();
  };
}

function ensureShutdownHandler() {
  for (const stale of shutdownRegistry) {
    process.off("beforeExit", stale);
    process.off("SIGINT", stale);
    process.off("SIGTERM", stale);
    process.off("exit", stale);
  }
  shutdownRegistry.clear();

  const handler = makeShutdownHandler();
  shutdownRegistry.add(handler);
  process.on("beforeExit", handler);
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  process.on("exit", handler);
}

ensureShutdownHandler();
