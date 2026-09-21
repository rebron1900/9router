// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";

// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
} from "./repos/apiKeysRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Standard model routing
export {
  getStandardModels, getStandardModelById, getStandardModelByName,
  createStandardModel, updateStandardModel, deleteStandardModel,
  reorderStandardModels,
  getStandardModelBindings, createStandardModelBinding, createStandardModelBindingWithMappings,
  updateStandardModelBinding, updateStandardModelBindingWithMappings, deleteStandardModelBinding,
  replaceStandardModelMappings,
} from "./repos/standardModelsRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Provider model catalog
export {
  MODEL_CATALOG_SCOPE,
  getProviderModelCatalog,
  getProviderModelCatalogs,
  upsertProviderModelCatalog,
  deleteProviderModelCatalog,
  clearProviderModelCatalog,
} from "./repos/modelCatalogRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
} from "./repos/requestDetailsRepo.js";

// Export/import full DB
export async function exportDb() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    settings: await exportSettings(),
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({ id: r.id, key: r.key, name: r.name, machineId: r.machineId, isActive: r.isActive === 1, createdAt: r.createdAt })),
    combos: db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    standardModels: db.all(`SELECT * FROM standardModels`).map((r) => ({
      id: r.id,
      publicName: r.publicName,
      publisher: r.publisher,
      officialModelId: r.officialModelId,
      displayName: r.displayName,
      lifecycle: r.lifecycle,
      enabled: r.enabled === 1,
      capabilities: parseJson(r.capabilities, {}),
      limits: parseJson(r.limits, {}),
      policy: parseJson(r.policy, {}),
      sourceUrl: r.sourceUrl,
      verifiedAt: r.verifiedAt,
      catalogVersion: r.catalogVersion,
      revision: r.revision,
      sortOrder: r.sortOrder,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      providers: db.all(`SELECT * FROM standardModelProviders WHERE standardModelId = ?`, [r.id]).map((p) => ({
        id: p.id,
        providerId: p.providerId,
        enabled: p.enabled === 1,
        priority: p.priority,
        data: parseJson(p.data, {}),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        mappings: db.all(`SELECT * FROM standardModelMappings WHERE providerBindingId = ?`, [p.id]).map((m) => ({
          id: m.id,
          upstreamModelId: m.upstreamModelId,
          enabled: m.enabled === 1,
          mappingPriority: m.mappingPriority,
          requestFormats: parseJson(m.requestFormats, []),
          operations: parseJson(m.operations, []),
          capabilityOverrides: parseJson(m.capabilityOverrides, {}),
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        })),
      })),
    })),
    modelAliases: {},
    customModels: [],
    providerModelCatalog: [],
    mitmAlias: {},
    pricing: {},
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'providerModelCatalog'`)) out.providerModelCatalog.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);

  return out;
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();

  db.transaction(() => {
    // Wipe all tables (keep _meta)
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM proxyPools`);
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM combos`);
    db.run(`DELETE FROM standardModelMappings`);
    db.run(`DELETE FROM standardModelProviders`);
    db.run(`DELETE FROM standardModels`);
    db.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'providerModelCatalog', 'mitmAlias', 'pricing')`);

    // Settings
    if (payload.settings) {
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
    }

    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      db.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run(
        `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const k of payload.apiKeys || []) {
      db.run(
        `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString()]
      );
    }
    for (const c of payload.combos || []) {
      db.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    for (const model of payload.standardModels || []) {
      db.run(
        `INSERT OR REPLACE INTO standardModels
          (id, publicName, publisher, officialModelId, displayName, lifecycle, enabled,
           capabilities, limits, policy, sourceUrl, verifiedAt, catalogVersion, revision, sortOrder,
           createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [model.id, model.publicName, model.publisher || null, model.officialModelId || model.publicName,
          model.displayName || model.publicName, model.lifecycle || "active", model.enabled === false ? 0 : 1,
          stringifyJson(model.capabilities || {}), stringifyJson(model.limits || {}), stringifyJson(model.policy || {}),
          model.sourceUrl || null, model.verifiedAt || null, model.catalogVersion || null, model.revision || 1, model.sortOrder || 0,
          model.createdAt || new Date().toISOString(), model.updatedAt || new Date().toISOString()],
      );
      for (const provider of model.providers || []) {
        db.run(
          `INSERT OR REPLACE INTO standardModelProviders
            (id, standardModelId, providerId, enabled, priority, weight, data, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [provider.id, model.id, provider.providerId, provider.enabled === false ? 0 : 1,
            Math.max(1, Number(provider.priority) || 1), 100,
            stringifyJson(provider.data || {}), provider.createdAt || new Date().toISOString(), provider.updatedAt || new Date().toISOString()],
        );
        for (const mapping of provider.mappings || []) {
          db.run(
            `INSERT OR REPLACE INTO standardModelMappings
              (id, providerBindingId, upstreamModelId, enabled, mappingPriority, requestFormats, operations, capabilityOverrides, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [mapping.id, provider.id, mapping.upstreamModelId, mapping.enabled === false ? 0 : 1,
              Math.max(1, Number(mapping.mappingPriority) || 1), stringifyJson(mapping.requestFormats || []),
              stringifyJson(mapping.operations || []), stringifyJson(mapping.capabilityOverrides || {}),
              mapping.createdAt || new Date().toISOString(), mapping.updatedAt || new Date().toISOString()],
          );
        }
      }
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const m of payload.providerModelCatalog || []) {
      if (!m?.providerId || !m?.modelId) continue;
      const k = `${m.providerId}|${m.modelId}|${m.kind || "llm"}`;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('providerModelCatalog', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
    }
  });

  return await exportDb();
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
