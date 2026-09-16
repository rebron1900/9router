"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import { translate } from "@/i18n/runtime";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
import { normalizeProviderModel } from "@/shared/utils/providerModelCatalog";
import ModelRow from "./ModelRow";
import ModelCatalogToolbar from "./ModelCatalogToolbar";

export default function CompatibleModelsSection({ providerStorageAlias, providerDisplayAlias, modelAliases, customModels, liveModels, disabledModelIds, copied, onCopy, onDeleteAlias, onAddCustomModel, onDeleteCustomModel, onDisableModel, onEnableModel, connections, isAnthropic }) {
  const [newModel, setNewModel] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [testingModelId, setTestingModelId] = useState(null);
  const [modelTestResults, setModelTestResults] = useState({});
  const [modelQuery, setModelQuery] = useState("");
  const [modelFilter, setModelFilter] = useState("all");

  const handleTestModel = async (modelId) => {
    if (testingModelId) return;
    setTestingModelId(modelId);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerStorageAlias}/${modelId}` }),
      });
      const data = await res.json();
      setModelTestResults((prev) => ({ ...prev, [modelId]: data.ok ? "ok" : "error" }));
    } catch {
      setModelTestResults((prev) => ({ ...prev, [modelId]: "error" }));
    } finally {
      setTestingModelId(null);
    }
  };

  const configuredModels = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias: providerStorageAlias,
    type: "llm",
  });
  const configuredIds = new Set(configuredModels.map((model) => model.id));
  const disabledSet = new Set(disabledModelIds || []);
  const liveCatalogModels = (liveModels || []).filter((model) => model?.id && !configuredIds.has(model.id));
  const activeConfiguredModels = configuredModels.filter((model) => !disabledSet.has(model.id));
  const hiddenConfiguredModels = configuredModels.filter((model) => disabledSet.has(model.id));
  const activeLiveCatalogModels = liveCatalogModels.filter((model) => !disabledSet.has(model.id));
  const hiddenLiveCatalogModels = liveCatalogModels.filter((model) => disabledSet.has(model.id));
  const allCatalogModels = [
    ...activeConfiguredModels.map((model) => ({ ...model, isCustom: true, isLive: false, isDisabled: false })),
    ...activeLiveCatalogModels.map((model) => ({ ...model, isCustom: false, isLive: true, isDisabled: false })),
    ...hiddenConfiguredModels.map((model) => ({ ...model, isCustom: true, isLive: false, isDisabled: true })),
    ...hiddenLiveCatalogModels.map((model) => ({ ...model, isCustom: false, isLive: true, isDisabled: true })),
  ];
  const normalizedQuery = modelQuery.trim().toLowerCase();
  const matchesQuery = (model) => !normalizedQuery
    || [model.id, model.name, model.alias].filter(Boolean).some((value) => String(value).toLowerCase().includes(normalizedQuery));
  const matchesFilter = (model) => modelFilter === "all"
    || (modelFilter === "custom" && model.isCustom && !model.isDisabled)
    || (modelFilter === "live" && model.isLive)
    || (modelFilter === "active" && !model.isDisabled)
    || (modelFilter === "hidden" && model.isDisabled);
  const filteredCatalogModels = allCatalogModels.filter((model) => matchesQuery(model) && matchesFilter(model));
  const catalogCounts = {
    all: allCatalogModels.length,
    active: activeConfiguredModels.length + activeLiveCatalogModels.length,
    custom: configuredModels.length,
    live: liveCatalogModels.length,
    hidden: hiddenConfiguredModels.length + hiddenLiveCatalogModels.length,
    visible: filteredCatalogModels.length,
  };

  const handleAdd = async () => {
    if (!newModel.trim() || adding) return;
    const modelId = newModel.trim();
    if (configuredModels.some((model) => model.id === modelId)) {
      alert(translate("Model already exists for this provider."));
      return;
    }

    setAdding(true);
    try {
      await onAddCustomModel(modelId);
      setNewModel("");
    } catch (error) {
      console.log("Error adding model:", error);
    } finally {
      setAdding(false);
    }
  };

  const handleImport = async () => {
    if (importing) return;
    const activeConnection = connections.find((conn) => conn.isActive !== false);
    if (!activeConnection) return;

    setImporting(true);
    try {
      const res = await fetch(`/api/providers/${activeConnection.id}/models`);
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || translate("Failed to import models"));
        return;
      }
      const models = data.models || [];
      if (models.length === 0) {
        alert(translate("No models returned from /models."));
        return;
      }
      let importedCount = 0;
      for (const model of models) {
        const normalizedModel = normalizeProviderModel(model, {
          providerId: providerStorageAlias,
          providerAlias: providerStorageAlias,
        });
        const modelId = normalizedModel?.id;
        if (!modelId) continue;
        if (configuredModels.some((entry) => entry.id === modelId)) continue;
        await onAddCustomModel(modelId);
        importedCount += 1;
      }
      if (importedCount === 0) {
        alert(translate("No new models were added."));
      }
    } catch (error) {
      console.log("Error importing models:", error);
    } finally {
      setImporting(false);
    }
  };

  const canImport = connections.some((conn) => conn.isActive !== false);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        {translate(isAnthropic
          ? "Add Anthropic-compatible models manually or import them from the /models endpoint."
          : "Add OpenAI-compatible models manually or import them from the /models endpoint.")}
      </p>

      <ModelCatalogToolbar
        query={modelQuery}
        onQueryChange={setModelQuery}
        filter={modelFilter}
        onFilterChange={setModelFilter}
        counts={catalogCounts}
      />

      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label htmlFor="new-compatible-model-input" className="text-xs text-text-muted mb-1 block">{translate("Model ID")}</label>
          <input
            id="new-compatible-model-input"
            type="text"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder={isAnthropic ? "claude-3-opus-20240229" : "gpt-4o"}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          />
        </div>
        <Button size="sm" icon="add" onClick={handleAdd} disabled={!newModel.trim() || adding}>
          {adding ? translate("Adding...") : translate("Add")}
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={handleImport} disabled={!canImport || importing}>
          {importing ? translate("Importing...") : translate("Import from /models")}
        </Button>
      </div>

      {!canImport && (
        <p className="text-xs text-text-muted">
          {translate("Add a connection to enable importing models.")}
        </p>
      )}

      {(allCatalogModels.length > 0) && (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
          {filteredCatalogModels.filter((model) => model.isCustom && !model.isDisabled).map(({ id, alias, source }) => (
            <ModelRow
              key={`${source}-${providerStorageAlias}/${id}`}
              model={{ id, name: source === "legacyAlias" && alias !== id ? alias : undefined }}
              fullModel={`${providerDisplayAlias}/${id}`}
              copied={copied}
              onCopy={onCopy}
              onDeleteAlias={() => source === "custom" ? onDeleteCustomModel(id) : onDeleteAlias(alias)}
              onTest={connections.length > 0 ? () => handleTestModel(id) : undefined}
              testStatus={modelTestResults[id]}
              isTesting={testingModelId === id}
              isCustom
              onDisable={onDisableModel ? () => onDisableModel(id) : undefined}
              removeLabel={source === "custom" ? "Remove custom model" : "Remove model alias"}
            />
          ))}
          {filteredCatalogModels.filter((model) => model.isLive && !model.isDisabled).map((model) => (
            <ModelRow
              key={`live-${providerStorageAlias}/${model.id}`}
              model={model}
              fullModel={`${providerDisplayAlias}/${model.id}`}
              copied={copied}
              onCopy={onCopy}
              onTest={connections.length > 0 ? () => handleTestModel(model.id) : undefined}
              testStatus={modelTestResults[model.id]}
              isTesting={testingModelId === model.id}
              isLive
              onDisable={onDisableModel ? () => onDisableModel(model.id) : undefined}
            />
          ))}
          {filteredCatalogModels.filter((model) => model.isDisabled).map((model) => (
            <ModelRow
              key={`hidden-${model.source || "live"}-${providerStorageAlias}/${model.id}`}
              model={model}
              fullModel={`${providerDisplayAlias}/${model.id}`}
              copied={copied}
              onCopy={onCopy}
              testStatus={modelTestResults[model.id]}
              isDisabled
              isCustom={model.isCustom}
              isLive={model.isLive}
              sourceLabel={model.isCustom ? (model.source === "custom" ? "Custom" : "Alias") : "Live"}
              onRestore={onEnableModel ? () => onEnableModel(model.id) : undefined}
              onTest={connections.length > 0 ? () => handleTestModel(model.id) : undefined}
              isTesting={testingModelId === model.id}
              removeLabel={model.source === "custom" ? "Remove custom model" : "Remove model alias"}
            />
          ))}
        </div>
      )}
      {allCatalogModels.length > 0 && filteredCatalogModels.length === 0 && (
        <p className="py-8 text-center text-sm text-text-muted">{translate("No models match this view.")}</p>
      )}
    </div>
  );
}

CompatibleModelsSection.propTypes = {
  providerStorageAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  modelAliases: PropTypes.object.isRequired,
  customModels: PropTypes.arrayOf(PropTypes.object),
  liveModels: PropTypes.arrayOf(PropTypes.object),
  disabledModelIds: PropTypes.arrayOf(PropTypes.string),
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDeleteAlias: PropTypes.func.isRequired,
  onAddCustomModel: PropTypes.func.isRequired,
  onDeleteCustomModel: PropTypes.func.isRequired,
  onDisableModel: PropTypes.func,
  onEnableModel: PropTypes.func,
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
  })).isRequired,
  isAnthropic: PropTypes.bool,
};
