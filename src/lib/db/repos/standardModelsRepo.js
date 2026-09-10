import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function bool(value, fallback = true) {
  return value === undefined ? fallback : value !== false && value !== 0;
}

function parseList(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function rowToStandardModel(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicName: row.publicName,
    publisher: row.publisher || null,
    officialModelId: row.officialModelId,
    displayName: row.displayName || row.publicName,
    lifecycle: row.lifecycle || "active",
    enabled: row.enabled !== 0,
    capabilities: parseJson(row.capabilities, {}),
    limits: parseJson(row.limits, {}),
    policy: parseJson(row.policy, {}),
    sourceUrl: row.sourceUrl || null,
    verifiedAt: row.verifiedAt || null,
    catalogVersion: row.catalogVersion || null,
    revision: Number(row.revision) || 1,
    sortOrder: Number(row.sortOrder) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    providerCount: Number(row.providerCount) || 0,
    enabledProviderCount: Number(row.enabledProviderCount) || 0,
  };
}

function rowToBinding(row, mappings = []) {
  if (!row) return null;
  return {
    id: row.id,
    standardModelId: row.standardModelId,
    providerId: row.providerId,
    enabled: row.enabled !== 0,
    priority: Math.max(1, Number(row.priority) || 1),
    data: parseJson(row.data, {}),
    configured: Number(row.connectionCount) > 0,
    connectionCount: Number(row.connectionCount) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    mappings,
  };
}

function rowToMapping(row) {
  return {
    id: row.id,
    providerBindingId: row.providerBindingId,
    upstreamModelId: row.upstreamModelId,
    enabled: row.enabled !== 0,
    mappingPriority: Math.max(1, Number(row.mappingPriority) || 1),
    requestFormats: parseList(row.requestFormats),
    operations: parseList(row.operations),
    capabilityOverrides: parseJson(row.capabilityOverrides, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function standardModelSelect() {
  return `
    SELECT m.*,
      COUNT(DISTINCT p.id) AS providerCount,
      COUNT(DISTINCT CASE WHEN p.enabled = 1 THEN p.id END) AS enabledProviderCount
    FROM standardModels m
    LEFT JOIN standardModelProviders p ON p.standardModelId = m.id
  `;
}

export async function getStandardModels({ includeDisabled = true } = {}) {
  const db = await getAdapter();
  const where = includeDisabled ? "" : "WHERE m.enabled = 1";
  const rows = db.all(`${standardModelSelect()} ${where} GROUP BY m.id ORDER BY m.sortOrder ASC, m.publicName COLLATE NOCASE ASC`);
  return rows.map(rowToStandardModel);
}

export async function getStandardModelById(id) {
  const db = await getAdapter();
  const row = db.get(`${standardModelSelect()} WHERE m.id = ? GROUP BY m.id`, [id]);
  return rowToStandardModel(row);
}

export async function getStandardModelByName(publicName) {
  const db = await getAdapter();
  const row = db.get(`${standardModelSelect()} WHERE m.publicName = ? GROUP BY m.id`, [publicName]);
  return rowToStandardModel(row);
}

export async function createStandardModel(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const requestedSortOrder = Number(data.sortOrder);
  const nextSortOrder = Number(db.get("SELECT COALESCE(MAX(sortOrder), 0) + 1 AS nextOrder FROM standardModels")?.nextOrder) || 1;
  const model = {
    id: data.id || uuidv4(),
    publicName: data.publicName,
    publisher: data.publisher || null,
    officialModelId: data.officialModelId || data.publicName,
    displayName: data.displayName || data.publicName,
    lifecycle: data.lifecycle || "active",
    enabled: bool(data.enabled),
    capabilities: data.capabilities || {},
    limits: data.limits || {},
    policy: data.policy || {},
    sourceUrl: data.sourceUrl || null,
    verifiedAt: data.verifiedAt || null,
    catalogVersion: data.catalogVersion || null,
    revision: 1,
    sortOrder: Number.isFinite(requestedSortOrder) && requestedSortOrder > 0 ? Math.floor(requestedSortOrder) : nextSortOrder,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO standardModels
      (id, publicName, publisher, officialModelId, displayName, lifecycle, enabled,
       capabilities, limits, policy, sourceUrl, verifiedAt, catalogVersion, revision, sortOrder,
       createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      model.id, model.publicName, model.publisher, model.officialModelId, model.displayName,
      model.lifecycle, model.enabled ? 1 : 0, stringifyJson(model.capabilities), stringifyJson(model.limits),
      stringifyJson(model.policy), model.sourceUrl, model.verifiedAt, model.catalogVersion,
      model.revision, model.sortOrder, model.createdAt, model.updatedAt,
    ],
  );
  return model;
}

export async function updateStandardModel(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM standardModels WHERE id = ?`, [id]);
    if (!row) return;
    const current = rowToStandardModel(row);
    const merged = {
      ...current,
      ...data,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    db.run(
      `UPDATE standardModels SET publicName = ?, publisher = ?, officialModelId = ?, displayName = ?,
       lifecycle = ?, enabled = ?, capabilities = ?, limits = ?, policy = ?, sourceUrl = ?,
       verifiedAt = ?, catalogVersion = ?, revision = ?, sortOrder = ?, updatedAt = ? WHERE id = ?`,
      [
        merged.publicName, merged.publisher || null, merged.officialModelId, merged.displayName,
        merged.lifecycle, merged.enabled ? 1 : 0, stringifyJson(merged.capabilities || {}),
        stringifyJson(merged.limits || {}), stringifyJson(merged.policy || {}), merged.sourceUrl || null,
        merged.verifiedAt || null, merged.catalogVersion || null, merged.revision, merged.sortOrder, merged.updatedAt, id,
      ],
    );
    result = merged;
  });
  return result;
}

export async function reorderStandardModels(ids) {
  const db = await getAdapter();
  const rows = db.all("SELECT id FROM standardModels ORDER BY sortOrder ASC, publicName COLLATE NOCASE ASC");
  const knownIds = new Set(rows.map((row) => row.id));
  const requestedIds = Array.isArray(ids) ? ids.map((id) => String(id)) : [];
  const seen = new Set();
  const orderedIds = [
    ...requestedIds.filter((id) => knownIds.has(id) && !seen.has(id) && seen.add(id)),
    ...rows.map((row) => row.id).filter((id) => !seen.has(id)),
  ];
  const now = new Date().toISOString();
  db.transaction(() => {
    orderedIds.forEach((id, index) => {
      db.run("UPDATE standardModels SET sortOrder = ?, updatedAt = ? WHERE id = ?", [index + 1, now, id]);
    });
  });
  return orderedIds;
}

export async function deleteStandardModel(id) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    db.run(`DELETE FROM standardModelMappings WHERE providerBindingId IN (SELECT id FROM standardModelProviders WHERE standardModelId = ?)`, [id]);
    db.run(`DELETE FROM standardModelProviders WHERE standardModelId = ?`, [id]);
    const result = db.run(`DELETE FROM standardModels WHERE id = ?`, [id]);
    deleted = (result?.changes || 0) > 0;
  });
  return deleted;
}

export async function getStandardModelBindings(standardModelId) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT p.*, COUNT(DISTINCT c.id) AS connectionCount
     FROM standardModelProviders p
     LEFT JOIN providerConnections c ON c.provider = p.providerId AND c.isActive = 1
     WHERE p.standardModelId = ?
     GROUP BY p.id
     ORDER BY p.priority ASC, p.providerId COLLATE NOCASE ASC`,
    [standardModelId],
  );
  const mappingRows = db.all(
    `SELECT * FROM standardModelMappings WHERE providerBindingId IN
       (SELECT id FROM standardModelProviders WHERE standardModelId = ?)
     ORDER BY mappingPriority ASC, upstreamModelId COLLATE NOCASE ASC`,
    [standardModelId],
  );
  const byBinding = new Map();
  for (const row of mappingRows) {
    const item = rowToMapping(row);
    const list = byBinding.get(item.providerBindingId) || [];
    list.push(item);
    byBinding.set(item.providerBindingId, list);
  }
  return rows.map((row) => rowToBinding(row, byBinding.get(row.id) || []));
}

export async function createStandardModelBinding(standardModelId, data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const binding = {
    id: data.id || uuidv4(),
    standardModelId,
    providerId: data.providerId,
    enabled: bool(data.enabled),
    priority: Math.max(1, Number(data.priority) || 1),
    data: data.data || {},
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO standardModelProviders
      (id, standardModelId, providerId, enabled, priority, weight, data, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [binding.id, binding.standardModelId, binding.providerId, binding.enabled ? 1 : 0,
      binding.priority, 100, stringifyJson(binding.data), binding.createdAt, binding.updatedAt],
  );
  return binding;
}

export async function updateStandardModelBinding(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM standardModelProviders WHERE id = ?`, [id]);
    if (!row) return;
    const current = rowToBinding(row);
    const merged = {
      ...current,
      ...data,
      priority: Math.max(1, Number(data.priority ?? current.priority) || 1),
      updatedAt: new Date().toISOString(),
    };
    db.run(
      `UPDATE standardModelProviders SET providerId = ?, enabled = ?, priority = ?, weight = ?, data = ?, updatedAt = ? WHERE id = ?`,
      [merged.providerId, merged.enabled ? 1 : 0, merged.priority, 100, stringifyJson(merged.data || {}), merged.updatedAt, id],
    );
    result = merged;
  });
  return result;
}

export async function deleteStandardModelBinding(id) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    db.run(`DELETE FROM standardModelMappings WHERE providerBindingId = ?`, [id]);
    const result = db.run(`DELETE FROM standardModelProviders WHERE id = ?`, [id]);
    deleted = (result?.changes || 0) > 0;
  });
  return deleted;
}

export async function replaceStandardModelMappings(bindingId, mappings) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const normalized = (Array.isArray(mappings) ? mappings : []).map((mapping) => ({
    id: mapping.id || uuidv4(),
    providerBindingId: bindingId,
    upstreamModelId: String(mapping.upstreamModelId || "").trim(),
    enabled: bool(mapping.enabled),
    mappingPriority: Math.max(1, Number(mapping.mappingPriority) || 1),
    requestFormats: Array.isArray(mapping.requestFormats) ? mapping.requestFormats.filter(Boolean) : [],
    operations: Array.isArray(mapping.operations) ? mapping.operations.filter(Boolean) : [],
    capabilityOverrides: mapping.capabilityOverrides || {},
    createdAt: mapping.createdAt || now,
    updatedAt: now,
  }));
  if (normalized.some((mapping) => !mapping.upstreamModelId)) throw new Error("upstreamModelId is required");
  db.transaction(() => {
    db.run(`DELETE FROM standardModelMappings WHERE providerBindingId = ?`, [bindingId]);
    for (const mapping of normalized) {
      db.run(
        `INSERT INTO standardModelMappings
          (id, providerBindingId, upstreamModelId, enabled, mappingPriority, requestFormats, operations, capabilityOverrides, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [mapping.id, bindingId, mapping.upstreamModelId, mapping.enabled ? 1 : 0, mapping.mappingPriority,
          stringifyJson(mapping.requestFormats), stringifyJson(mapping.operations), stringifyJson(mapping.capabilityOverrides),
          mapping.createdAt, mapping.updatedAt],
      );
    }
  });
  return normalized;
}
