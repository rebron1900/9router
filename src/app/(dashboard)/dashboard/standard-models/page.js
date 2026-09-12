"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { ModelSelectModal } from "@/shared/components";
import { getModelsByProviderId } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";
import { onLocaleChange, translate } from "@/i18n/runtime";

const EMPTY_MODEL = {
  publicName: "",
  officialModelId: "",
  publisher: "",
  displayName: "",
  sourceUrl: "",
  lifecycle: "active",
  enabled: true,
  capabilities: {},
};

const EMPTY_BINDING = {
  providerId: "",
  upstreamModelId: "",
  priority: 1,
};

const DEFAULT_ROUTING_SETTINGS = {
  enabled: false,
  modelListMode: "both",
  defaultPolicy: {
    fallbackStrategy: "sequential",
    maxProviderAttempts: 3,
    maxAccountAttemptsPerProvider: 2,
    maxGenerationAttempts: 6,
  },
};

function normalizeRoutingSettings(value) {
  const defaultPolicy = {
    ...DEFAULT_ROUTING_SETTINGS.defaultPolicy,
    ...(value?.defaultPolicy || {}),
  };
  delete defaultPolicy.selection;
  return {
    ...DEFAULT_ROUTING_SETTINGS,
    ...(value || {}),
    defaultPolicy,
  };
}

function statusLabel(model) {
  if (!model.enabled) return translate("Disabled");
  if (model.lifecycle !== "active") return translate(model.lifecycle);
  return translate("Enabled");
}

function normalizeProviderModel(model) {
  if (typeof model === "string") {
    return { id: model, name: model };
  }
  const id = model?.id || model?.model || model?.name || model?.upstreamModelId;
  if (!id) return null;
  return {
    id: String(id),
    name: String(model?.displayName || model?.display_name || model?.name || id),
  };
}

function getLocalProviderModels(providerId, connections) {
  const providerConnections = connections.filter((connection) => connection.provider === providerId);
  const configuredModels = providerConnections.flatMap((connection) => {
    const enabledModels = connection.providerSpecificData?.enabledModels;
    return Array.isArray(enabledModels) ? enabledModels : [];
  });
  const source = configuredModels.length > 0 ? configuredModels : getModelsByProviderId(providerId);
  const seen = new Set();
  return source.map(normalizeProviderModel).filter((model) => {
    if (!model || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function normalizeModelIdentity(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function providerModelMatchScore(model, standardModel) {
  const canonical = normalizeModelIdentity(standardModel?.publicName || standardModel?.officialModelId);
  if (!canonical) return 0;

  const values = [model.id, model.name]
    .filter(Boolean)
    .flatMap((value) => {
      const normalized = normalizeModelIdentity(value);
      const tail = normalizeModelIdentity(String(value).split("/").pop());
      return [normalized, tail];
    });

  if (values.includes(canonical)) return 100;
  if (values.some((value) => value.endsWith(`-${canonical}`))) return 90;
  if (values.some((value) => value.startsWith(`${canonical}-`))) return 80;
  return 0;
}

function bindingSelectorValues(binding) {
  const values = [];
  if (binding?.data?.selectorValue) values.push(String(binding.data.selectorValue));
  for (const mapping of binding?.mappings || []) {
    if (mapping?.upstreamModelId && binding?.providerId) {
      values.push(`${getProviderAlias(binding.providerId)}/${mapping.upstreamModelId}`);
    }
  }
  return [...new Set(values)];
}

function providerModelSelectionKey(model) {
  return `${model?.providerId || ""}:${model?.id || ""}`;
}

export default function StandardModelsPage() {
  const t = translate;
  const [, refreshLocale] = useState(0);
  const [models, setModels] = useState([]);
  const [providers, setProviders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [bindings, setBindings] = useState([]);
  const [preview, setPreview] = useState(null);
  const [routingSettings, setRoutingSettings] = useState(DEFAULT_ROUTING_SETTINGS);
  const [modelForm, setModelForm] = useState(EMPTY_MODEL);
  const [bindingForm, setBindingForm] = useState(EMPTY_BINDING);
  const [showModelForm, setShowModelForm] = useState(false);
  const [showBindingForm, setShowBindingForm] = useState(false);
  const [catalogModels, setCatalogModels] = useState([]);
  const [modelSource, setModelSource] = useState("catalog");
  const [selectedCatalogModel, setSelectedCatalogModel] = useState(null);
  const [editingModel, setEditingModel] = useState(null);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [providerModels, setProviderModels] = useState([]);
  const [showProviderModelPicker, setShowProviderModelPicker] = useState(false);
  const [pendingProviderModels, setPendingProviderModels] = useState([]);
  const [editingBinding, setEditingBinding] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => onLocaleChange(() => refreshLocale((value) => value + 1)), [refreshLocale]);

  const loadBindings = async (modelId) => {
    const response = await fetch(`/api/models/standard/${modelId}/providers`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load provider mappings");
    setBindings(data.providers || []);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [modelsRes, providersRes, settingsRes, catalogRes] = await Promise.all([
        fetch("/api/models/standard"),
        fetch("/api/providers"),
        fetch("/api/settings"),
        fetch("/api/models/standard/catalog"),
      ]);
      const modelsData = await modelsRes.json();
      const providersData = await providersRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      const catalogData = catalogRes.ok ? await catalogRes.json() : { models: [] };
      if (!modelsRes.ok) throw new Error(modelsData.error || "Failed to load standard models");
      setModels(modelsData.models || []);
      setProviders(providersData.connections || []);
      setCatalogModels(catalogData.models || []);
      setRoutingSettings(normalizeRoutingSettings(settingsData.standardModelRouting));
      if (selected) {
        const next = (modelsData.models || []).find((model) => model.id === selected.id);
        if (next) {
          setSelected(next);
          await loadBindings(next.id);
        }
      }
    } catch (err) {
      setError(err.message || "Failed to load standard model settings");
    } finally {
      setLoading(false);
    }
  }, [selected]);

  // Initial data loading is intentionally kicked off once when the page mounts.
  // The loader owns the async state updates and is not an external subscription.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { load(); }, []);

  const providerOptions = useMemo(() => {
    const values = new Map();
    for (const connection of providers) {
      if (!connection.provider) continue;
      const current = values.get(connection.provider) || {
        id: connection.provider,
        name: connection.provider,
        connections: [],
      };
      current.name = current.name === current.id && connection.name ? connection.name : current.name;
      current.connections.push(connection);
      values.set(connection.provider, current);
    }
    return [...values.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [providers]);

  const selectableProviderOptions = useMemo(() => {
    return providerOptions;
  }, [providerOptions]);

  const selectedProviderConnections = useMemo(
    () => providers.filter((connection) => connection.provider === bindingForm.providerId),
    [providers, bindingForm.providerId],
  );

  const addedModelValues = useMemo(
    () => bindings.flatMap(bindingSelectorValues),
    [bindings],
  );

  const filteredCatalogModels = useMemo(() => {
    const query = catalogSearch.trim().toLowerCase();
    return catalogModels.filter((model) => {
      if (!query) return true;
      return [model.publicName, model.displayName, model.publisher]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [catalogModels, catalogSearch]);

  const loadProviderModels = useCallback((providerId) => {
    setProviderModels([]);
    if (!providerId) return;
    const normalizedModels = getLocalProviderModels(providerId, providers)
      .map((model) => {
        const matchScore = providerModelMatchScore(model, selected);
        return { ...model, matchScore, matched: matchScore > 0 };
      })
      .sort((a, b) => b.matchScore - a.matchScore || a.id.localeCompare(b.id));
    setProviderModels(normalizedModels);
    const bestMatch = normalizedModels.find((model) => model.matchScore >= 90);
    if (bestMatch) {
      setBindingForm((current) => current.upstreamModelId ? current : { ...current, upstreamModelId: bestMatch.id });
    }
  }, [providers, selected]);

  const selectModel = async (model) => {
    setSelected(model);
    setPreview(null);
    setError("");
    try {
      await loadBindings(model.id);
    } catch (err) {
      setError(err.message || "Failed to load provider mappings");
    }
  };

  const saveRoutingSettings = async (next) => {
    const normalized = normalizeRoutingSettings(next);
    setRoutingSettings(normalized);
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ standardModelRouting: normalized }),
    });
    if (!response.ok) throw new Error("Failed to save standard model routing settings");
  };

  const updateRoutingPolicy = async (key, value) => {
    try {
      await saveRoutingSettings({
        ...routingSettings,
        defaultPolicy: { ...routingSettings.defaultPolicy, [key]: value },
      });
    } catch (err) {
      setError(err.message || "Failed to save routing policy");
    }
  };

  const openCreateModel = () => {
    setEditingModel(null);
    setModelSource("catalog");
    setModelForm(EMPTY_MODEL);
    setSelectedCatalogModel(null);
    setCatalogSearch("");
    setShowModelForm(true);
  };

  const openEditModel = (model) => {
    setEditingModel(model);
    setModelSource("custom");
    setSelectedCatalogModel(null);
    setModelForm({ ...EMPTY_MODEL, ...model });
    setShowModelForm(true);
  };

  const openCreateBindingForm = () => {
    setEditingBinding(null);
    setBindingForm(EMPTY_BINDING);
    setProviderModels([]);
    setShowBindingForm(true);
  };

  const getBindingSelection = (binding) => {
    const mapping = binding?.mappings?.[0];
    if (!binding?.providerId || !mapping?.upstreamModelId) return null;
    return {
      providerId: binding.providerId,
      id: mapping.upstreamModelId,
      name: binding.data?.selectorName || mapping.upstreamModelId,
      value: binding.data?.selectorValue || `${getProviderAlias(binding.providerId)}/${mapping.upstreamModelId}`,
      bindingId: binding.id,
    };
  };

  const openProviderModelPicker = (binding = null) => {
    setEditingBinding(binding);
    setPendingProviderModels(bindings.map(getBindingSelection).filter(Boolean));
    setError("");
    setShowProviderModelPicker(true);
  };

  const openEditBinding = (binding) => {
    if (!binding?.id) return;
    openProviderModelPicker(binding);
  };

  const createModel = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const isEditing = Boolean(editingModel);
      const response = await fetch(isEditing ? `/api/models/standard/${editingModel.id}` : "/api/models/standard", {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isEditing || modelSource === "custom" ? modelForm : selectedCatalogModel),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || (isEditing ? "Failed to update standard model" : "Failed to create standard model"));
      setModelForm(EMPTY_MODEL);
      setSelectedCatalogModel(null);
      setEditingModel(null);
      setShowModelForm(false);
      await load();
      await selectModel(data);
    } catch (err) {
      setError(err.message || (editingModel ? "Update failed" : "Creation failed"));
    } finally {
      setSaving(false);
    }
  };

  const handleStandardModelDragEnd = async ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const oldIndex = models.findIndex((model) => model.id === active.id);
    const newIndex = models.findIndex((model) => model.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(models, oldIndex, newIndex);
    setModels(reordered);
    setError("");
    try {
      const response = await fetch("/api/models/standard/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: reordered.map((model) => model.id) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to save standard model order");
      if (Array.isArray(data.models)) setModels(data.models);
    } catch (err) {
      setError(err.message || "Failed to save standard model order");
      await load();
    }
  };

  const deleteStandardModel = async (model) => {
    const action = model.catalogVersion ? translate("Remove local registration") : translate("Delete custom model");
    const details = model.catalogVersion
      ? translate("The system catalog entry will remain available for registration again.")
      : translate("The provider mappings for this model will also be deleted.");
    if (!window.confirm(`${action} "${model.publicName}"? ${details}`)) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/models/standard/${model.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `${action} failed`);
      if (selected?.id === model.id) {
        setSelected(null);
        setBindings([]);
        setPreview(null);
      }
      await load();
    } catch (err) {
      setError(err.message || `${action} failed`);
    } finally {
      setSaving(false);
    }
  };

  const addBinding = async (event) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/models/standard/${selected.id}/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: bindingForm.providerId,
          priority: Number(bindingForm.priority),
          mappings: [{ upstreamModelId: bindingForm.upstreamModelId }],
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to add provider mapping");
      setBindingForm(EMPTY_BINDING);
      setShowBindingForm(false);
      await loadBindings(selected.id);
      await load();
    } catch (err) {
      setError(err.message || "Failed to add mapping");
    } finally {
      setSaving(false);
    }
  };

  const pendingProviderModelValues = useMemo(
    () => pendingProviderModels.map((model) => model.value || `${getProviderAlias(model.providerId)}/${model.id}`),
    [pendingProviderModels],
  );

  // The picker represents the complete provider-model set for this standard
  // model. Existing cards are preselected; toggling a model off removes that
  // card when the selection is confirmed.
  const handleStandardModelSelect = (model) => {
    if (!selected || saving) return;
    const providerId = String(model?.providerId || "").trim();
    const upstreamModelId = String(model?.id || "").trim();
    if (!providerId || !upstreamModelId || upstreamModelId.startsWith("__placeholder__")) {
      setError("Select a specific model under a provider group. Use manual entry for models that cannot be discovered.");
      return;
    }
    const selectionKey = providerModelSelectionKey({ providerId, id: upstreamModelId });
    setError("");
    setPendingProviderModels((current) => {
      if (current.some((item) => providerModelSelectionKey(item) === selectionKey)) {
        return current.filter((item) => providerModelSelectionKey(item) !== selectionKey);
      }
      return [...current, { ...model, providerId, id: upstreamModelId }];
    });
  };

  const confirmStandardModelSelection = async () => {
    if (!selected || saving) return;
    setSaving(true);
    setError("");
    let changedCount = 0;
    try {
      const existingByKey = new Map();
      for (const binding of bindings) {
        const selection = getBindingSelection(binding);
        if (selection) existingByKey.set(providerModelSelectionKey(selection), { binding, selection });
      }
      const desiredKeys = new Set(pendingProviderModels.map(providerModelSelectionKey));

      // Delete cards that were deselected in the Combo-style picker.
      for (const { binding, selection } of existingByKey.values()) {
        if (desiredKeys.has(providerModelSelectionKey(selection))) continue;
        const response = await fetch(`/api/models/standard/${selected.id}/providers/${binding.id}`, { method: "DELETE" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Failed to remove ${selection.name || selection.id}`);
        changedCount += 1;
      }

      // Keep, update, or create each selected card in the current order.
      for (const [index, model] of pendingProviderModels.entries()) {
        const existing = existingByKey.get(providerModelSelectionKey(model));
        const mapping = existing?.binding?.mappings?.[0];
        const payload = {
          providerId: model.providerId,
          priority: index + 1,
          data: {
            selectorValue: model.value || `${getProviderAlias(model.providerId)}/${model.id}`,
            selectorName: model.name || model.id,
          },
          mappings: [{
            ...(mapping?.id ? { id: mapping.id } : {}),
            upstreamModelId: model.id,
            mappingPriority: 1,
          }],
        };
        const response = await fetch(existing
          ? `/api/models/standard/${selected.id}/providers/${existing.binding.id}`
          : `/api/models/standard/${selected.id}/providers`, {
          method: existing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Failed to save ${model.name || model.id}`);
        changedCount += 1;
      }

      if (changedCount === 0 && bindings.length === 0) {
        setShowProviderModelPicker(false);
        setEditingBinding(null);
        setPendingProviderModels([]);
        return;
      }
      setPendingProviderModels([]);
      setShowProviderModelPicker(false);
      setEditingBinding(null);
      await loadBindings(selected.id);
      await load();
    } catch (err) {
      setError(changedCount > 0 ? `Saved ${changedCount} changes; remaining changes failed: ${err.message}` : (err.message || "Failed to save provider models"));
    } finally {
      setSaving(false);
    }
  };

  const handleBindingDragEnd = async ({ active, over }) => {
    if (!over || active.id === over.id || !selected) return;
    const oldIndex = bindings.findIndex((binding) => binding.id === active.id);
    const newIndex = bindings.findIndex((binding) => binding.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(bindings, oldIndex, newIndex);
    setBindings(reordered);
    setError("");
    try {
      const responses = await Promise.all(reordered.map((binding, index) => fetch(
        `/api/models/standard/${selected.id}/providers/${binding.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priority: index + 1 }),
        },
      )));
      const failed = responses.find((response) => !response.ok);
      if (failed) throw new Error("Failed to save provider order");
      await load();
    } catch (err) {
      setError(err.message || "Failed to save provider order");
      await loadBindings(selected.id);
    }
  };

  const deleteBinding = async (bindingId) => {
    if (!selected || !window.confirm(translate("Delete this provider mapping?"))) return;
    const response = await fetch(`/api/models/standard/${selected.id}/providers/${bindingId}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) return setError(data.error || "Failed to delete mapping");
    await loadBindings(selected.id);
    await load();
  };

  const loadPreview = async () => {
    if (!selected) return;
    const response = await fetch(`/api/models/standard/${selected.id}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestFormat: "openai", requireConfiguredProvider: false }),
    });
    const data = await response.json();
    if (!response.ok) return setError(data.error || "Preview failed");
    setPreview(data);
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-main">{t("Standard Model Routing")}</h2>
          <p className="mt-1 text-sm text-text-muted">{t("Use official model names and configure multiple providers as interchangeable execution channels.")}</p>
          <p className="mt-1 text-xs text-text-muted">{t("When enabled, requests without a provider prefix automatically fail over through the configured channels in order.")}</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={routingSettings.enabled === true}
              onChange={async (event) => {
                try { await saveRoutingSettings({ ...routingSettings, enabled: event.target.checked }); } catch (err) { setError(err.message); }
              }}
            />
            {t("Enable standard model routing")}
          </label>
          <button className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white" onClick={openCreateModel}>
            {t("Add standard model")}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
        <label className="grid gap-1 text-text-muted"><span>{t("Provider failure fallback")}</span><select className="rounded-lg border border-border bg-background px-3 py-2 text-text-main" value={routingSettings.defaultPolicy.fallbackStrategy} onChange={(event) => updateRoutingPolicy("fallbackStrategy", event.target.value)}><option value="sequential">{t("Continue in candidate order")}</option><option value="none">{t("Do not fall back")}</option></select></label>
        <label className="grid gap-1 text-text-muted"><span>{t("Maximum provider attempts")}</span><input type="number" min="1" className="w-28 rounded-lg border border-border bg-background px-3 py-2 text-text-main" value={routingSettings.defaultPolicy.maxProviderAttempts} onChange={(event) => setRoutingSettings((current) => ({ ...current, defaultPolicy: { ...current.defaultPolicy, maxProviderAttempts: event.target.value } }))} onBlur={(event) => updateRoutingPolicy("maxProviderAttempts", Math.max(1, Number(event.target.value) || 1))} /></label>
        <label className="grid gap-1 text-text-muted"><span>{t("Maximum accounts per provider")}</span><input type="number" min="1" className="w-28 rounded-lg border border-border bg-background px-3 py-2 text-text-main" value={routingSettings.defaultPolicy.maxAccountAttemptsPerProvider} onChange={(event) => setRoutingSettings((current) => ({ ...current, defaultPolicy: { ...current.defaultPolicy, maxAccountAttemptsPerProvider: event.target.value } }))} onBlur={(event) => updateRoutingPolicy("maxAccountAttemptsPerProvider", Math.max(1, Number(event.target.value) || 1))} /></label>
        <label className="grid gap-1 text-text-muted"><span>{t("Maximum total attempts")}</span><input type="number" min="1" className="w-24 rounded-lg border border-border bg-background px-3 py-2 text-text-main" value={routingSettings.defaultPolicy.maxGenerationAttempts} onChange={(event) => setRoutingSettings((current) => ({ ...current, defaultPolicy: { ...current.defaultPolicy, maxGenerationAttempts: event.target.value } }))} onBlur={(event) => updateRoutingPolicy("maxGenerationAttempts", Math.max(1, Number(event.target.value) || 1))} /></label>
        <span className="pb-2 text-xs text-text-muted">{t("Cancelling a request stops subsequent provider attempts; streaming output is never stitched across providers.")}</span>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600">{translate(error)}</div>}

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(420px,1.2fr)]">
        <section className="overflow-hidden rounded-xl border border-border bg-surface">
          <div className="border-b border-border px-4 py-3 font-medium">{t("Standard model directory")}</div>
          {loading ? <div className="px-4 py-10 text-center text-sm text-text-muted">{t("Loading...")}</div> : models.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-text-muted">{t("No standard models registered yet. Choose one from the system catalog or create a custom model.")}</div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleStandardModelDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
              <SortableContext items={models.map((model) => model.id)} strategy={verticalListSortingStrategy}>
                <div className="flex min-w-0 flex-col divide-y divide-border">
                  {models.map((model) => (
                    <StandardModelItem
                      key={model.id}
                      model={model}
                      selected={selected?.id === model.id}
                      onSelect={() => selectModel(model)}
                      onEdit={() => openEditModel(model)}
                      onDelete={() => deleteStandardModel(model)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
          {models.length > 1 && <p className="border-t border-border px-4 py-2 text-xs text-text-muted">{t("Drag the handle to reorder the standard model directory.")}</p>}
        </section>

        <section className="min-w-0 rounded-xl border border-border bg-surface">
          {!selected ? <div className="flex min-h-64 items-center justify-center px-6 text-center text-sm text-text-muted">{t("Select a standard model to view its provider mappings.")}</div> : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
                <div>
                  <div className="font-medium text-text-main">{selected.displayName}</div>
                  <code className="text-xs text-text-muted">{selected.publicName}</code>
                </div>
                <div className="flex gap-2">
                  <button className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-main hover:bg-sidebar" onClick={loadPreview}>{t("Route preview")}</button>
                  <button className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white" onClick={() => openProviderModelPicker()}>{t("Add provider models")}</button>
                  <button className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-main hover:bg-sidebar" onClick={openCreateBindingForm}>{t("Add manually")}</button>
                </div>
              </div>
              <div className="p-4">
                {bindings.length === 0 ? <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">{t("No provider mappings yet.")}</div> : (
                  <>
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleBindingDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
                      <SortableContext items={bindings.map((binding) => binding.id)} strategy={verticalListSortingStrategy}>
                        <div className="flex min-w-0 flex-col divide-y divide-border">
                          {bindings.map((binding, index) => (
                            <StandardBindingItem
                              key={binding.id}
                              id={binding.id}
                              index={index}
                              binding={binding}
                              onEdit={() => openEditBinding(binding)}
                              onRemove={() => deleteBinding(binding.id)}
                            />
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                    <p className="mt-3 text-xs text-text-muted">{t("Drag the handle to set the fallback order.")}</p>
                  </>
                )}
                {preview && <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                  <div className="font-medium text-text-main">{t("Preview result")}</div>
                  <div className="mt-2 space-y-1 text-xs text-text-muted">
                    {preview.candidates?.map((candidate, index) => <div key={`${candidate.bindingId}-${candidate.mappingId}`}>{index + 1}. {candidate.providerId} → {candidate.upstreamModelId} ({t("priority")} {candidate.priority})</div>)}
                    {preview.excluded?.map((item) => <div key={`${item.providerId}-${item.reason}`} className="text-amber-700">{t("Excluded")}: {item.providerId} · {item.reason}</div>)}
                    {!preview.candidates?.length && <div>{t("No eligible candidates.")}</div>}
                  </div>
                </div>}
              </div>
            </>
          )}
        </section>
      </div>

      {showModelForm && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && setShowModelForm(false)}>
        <form className="w-full max-w-lg rounded-xl border border-border bg-surface p-5 shadow-xl" onSubmit={createModel}>
          <h3 className="text-lg font-semibold text-text-main">{editingModel ? t("Edit standard model") : t("Add standard model")}</h3>
          <p className="mt-1 text-xs text-text-muted">{editingModel ? (editingModel.catalogVersion ? t("The canonical name and official ID of system models are protected by the authoritative catalog; display information and status can be edited.") : t("Custom models can be edited, including their canonical name, mapping ID, display information, and status.")) : t("Prefer the system standard model catalog; models not covered there can still be fully customized.")}</p>
          {!editingModel && <div className="mt-4 flex gap-2 rounded-lg bg-surface-2 p-1 text-sm">
            <button type="button" className={`flex-1 rounded-md px-3 py-2 ${modelSource === "catalog" ? "bg-surface font-medium text-text-main shadow-sm" : "text-text-muted"}`} onClick={() => setModelSource("catalog")}>{t("System catalog")}</button>
            <button type="button" className={`flex-1 rounded-md px-3 py-2 ${modelSource === "custom" ? "bg-surface font-medium text-text-main shadow-sm" : "text-text-muted"}`} onClick={() => setModelSource("custom")}>{t("Custom model")}</button>
          </div>}
          {!editingModel && modelSource === "catalog" && <div className="mt-4 grid gap-3">
            <input className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-main outline-none focus:border-primary" placeholder={t("Search standard model name or publisher")} value={catalogSearch} onChange={(event) => setCatalogSearch(event.target.value)} />
            <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
              {filteredCatalogModels.length === 0 ? <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-text-muted">{t("No matching models in the system catalog. You can switch to a custom model.")}</div> : filteredCatalogModels.map((model) => <button type="button" key={model.publicName} disabled={model.registered} className={`w-full rounded-lg border px-3 py-2 text-left ${selectedCatalogModel?.publicName === model.publicName ? "border-primary bg-primary/10" : "border-border"} ${model.registered ? "cursor-not-allowed opacity-50" : "hover:border-primary/60"}`} onClick={() => setSelectedCatalogModel(model)}>
                <span className="flex items-center justify-between gap-3"><span className="font-medium text-text-main">{model.displayName || model.publicName}</span><span className="text-xs text-text-muted">{model.registered ? t("Registered") : model.publisher}</span></span>
                <code className="mt-1 block text-xs text-text-muted">{model.publicName}</code>
              </button>)}
            </div>
            {selectedCatalogModel && <div className="rounded-lg bg-primary/5 px-3 py-2 text-xs text-text-muted">{t("Selected")}: <code>{selectedCatalogModel.publicName}</code> · {selectedCatalogModel.publisher}</div>}
          </div>}
          {(editingModel || modelSource === "custom") && <div className="mt-4 grid gap-3">
            {[["publicName", "Canonical model name", "e.g. gpt-5.6-luna"], ["officialModelId", "Official model ID", "Original ID from the official API"], ["publisher", "Model publisher", "e.g. OpenAI"], ["displayName", "Display name", "Optional"], ["sourceUrl", "Official source URL", "Optional"]].map(([key, label, placeholder]) => <label key={key} className="grid gap-1 text-sm text-text-main"><span>{t(label)}</span><input className="rounded-lg border border-border bg-background px-3 py-2 outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60" value={modelForm[key] || ""} placeholder={t(placeholder)} onChange={(event) => setModelForm({ ...modelForm, [key]: event.target.value })} required={key === "publicName"} disabled={Boolean(editingModel?.catalogVersion) && (key === "publicName" || key === "officialModelId")} /></label>)}
            <label className="flex items-center gap-2 text-sm text-text-main"><input type="checkbox" checked={modelForm.enabled !== false} onChange={(event) => setModelForm({ ...modelForm, enabled: event.target.checked })} />{t("Enable this standard model")}</label>
            <label className="flex items-center gap-2 text-sm text-text-main"><input type="checkbox" checked={modelForm.capabilities?.imageOutput === true} onChange={(event) => setModelForm({ ...modelForm, capabilities: { ...(modelForm.capabilities || {}), imageOutput: event.target.checked } })} />{t("Image generation / editing capability")}</label>
            <label className="grid gap-1 text-sm text-text-main"><span>{t("Lifecycle")}</span><select className="rounded-lg border border-border bg-background px-3 py-2" value={modelForm.lifecycle || "active"} onChange={(event) => setModelForm({ ...modelForm, lifecycle: event.target.value })}><option value="active">{t("active")}</option><option value="preview">{t("preview")}</option><option value="deprecated">{t("deprecated")}</option><option value="retired">{t("retired")}</option></select></label>
          </div>}
          <div className="mt-5 flex justify-end gap-2"><button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" onClick={() => setShowModelForm(false)}>{t("Cancel")}</button><button disabled={saving || (!editingModel && modelSource === "catalog" && !selectedCatalogModel)} className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{editingModel ? t("Save changes") : t("Register model")}</button></div>
        </form>
      </div>}

      {showBindingForm && selected && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && setShowBindingForm(false)}>
        <form className="w-full max-w-lg rounded-xl border border-border bg-surface p-5 shadow-xl" onSubmit={addBinding}>
          <h3 className="text-lg font-semibold text-text-main">{t("Add provider model")}</h3>
          <p className="mt-1 text-xs text-text-muted">{t("Standard model")}: {selected.publicName}</p>
          <div className="mt-4 grid gap-3">
            <label className="grid gap-1 text-sm text-text-main"><span>{t("Provider")}</span><select className="rounded-lg border border-border bg-background px-3 py-2" value={bindingForm.providerId} onChange={(event) => { const providerId = event.target.value; setBindingForm({ ...bindingForm, providerId, upstreamModelId: "" }); void loadProviderModels(providerId); }} required><option value="">{t("Select a configured provider")}</option>{selectableProviderOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} ({provider.id}) · {provider.connections.length} {t("connections")}</option>)}</select></label>
            {bindingForm.providerId && <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2">
                <div className="min-w-0 text-xs text-text-muted"><div className="font-medium text-text-main">{t("Use the Combo model selector")}</div><div className="mt-0.5">{t("Search models by provider; the selected result fills the actual model ID automatically.")}</div></div>
                <button type="button" className="shrink-0 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white disabled:opacity-50" disabled={!selectedProviderConnections.length} onClick={() => setShowProviderModelPicker(true)}>{t("Select models")}</button>
              </div>
              {bindingForm.upstreamModelId && <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-muted">{t("Current model")}: <code className="font-mono text-text-main">{bindingForm.upstreamModelId}</code></div>}
              <div className="text-xs text-text-muted">{t("Available models from the local provider catalog")}</div>
              {providerModels.length > 0 && <select className="rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm" value={providerModels.some((model) => model.id === bindingForm.upstreamModelId) ? bindingForm.upstreamModelId : "__custom__"} onChange={(event) => setBindingForm({ ...bindingForm, upstreamModelId: event.target.value === "__custom__" ? "" : event.target.value })}>
                <option value="__custom__">{t("Enter another model ID manually")}</option>
                {providerModels.some((model) => model.matched) && <optgroup label={`${t("Matches standard model")}: ${selected.publicName}`}>
                  {providerModels.filter((model) => model.matched).map((model) => <option key={model.id} value={model.id}>{model.id}{model.name !== model.id ? ` · ${model.name}` : ""}</option>)}
                </optgroup>}
                {providerModels.some((model) => !model.matched) && <optgroup label={t("Other provider models")}>
                  {providerModels.filter((model) => !model.matched).map((model) => <option key={model.id} value={model.id}>{model.id}{model.name !== model.id ? ` · ${model.name}` : ""}</option>)}
                </optgroup>}
              </select>}
              {providerModels.some((model) => model.matched) && <div className="text-xs text-green-700">{t("Normalized matching used the standard model name and prioritized the matching result.")}</div>}
              {(providerModels.length === 0 || !providerModels.some((model) => model.id === bindingForm.upstreamModelId)) && <input className="rounded-lg border border-border bg-background px-3 py-2 font-mono" value={bindingForm.upstreamModelId} placeholder={t("e.g. luna or vendor/model-id")} onChange={(event) => setBindingForm({ ...bindingForm, upstreamModelId: event.target.value })} required />}
            </div>}
            <label className="grid gap-1 text-sm text-text-main"><span>{t("Insert order")}</span><input type="number" min="1" className="rounded-lg border border-border bg-background px-3 py-2" value={bindingForm.priority} onChange={(event) => setBindingForm({ ...bindingForm, priority: event.target.value })} /><span className="text-xs text-text-muted">{t("You can drag the list to adjust order after saving.")}</span></label>
          </div>
          <div className="mt-5 flex justify-end gap-2"><button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" onClick={() => setShowBindingForm(false)}>{t("Cancel")}</button><button disabled={saving} className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{t("Save mapping")}</button></div>
        </form>
      </div>}

      {showProviderModelPicker && selected && <ModelSelectModal
        isOpen={showProviderModelPicker}
        onClose={() => { setShowProviderModelPicker(false); setEditingBinding(null); setPendingProviderModels([]); }}
        onSelect={handleStandardModelSelect}
        activeProviders={providers}
        addedModelValues={addedModelValues}
        title={t(editingBinding ? "Edit provider models" : "Select provider models")}
        providerOnly
        preferredModelName={selected.officialModelId || selected.publicName}
        multiSelect
        selectedModelValues={pendingProviderModelValues}
        onConfirm={confirmStandardModelSelection}
        confirming={saving}
        confirmLabel="Save selection"
        allowEmptySelection
        extraModels={bindings.map(getBindingSelection).filter(Boolean)}
        closeOnSelect={false}
      />}
    </div>
  );
}

function StandardModelItem({ model, selected, onSelect, onEdit, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id: model.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.45 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className={`flex min-w-0 items-center gap-2 px-3 py-2 transition-colors ${selected ? "bg-primary/10" : "hover:bg-sidebar/50"} ${isDragging ? "ring-1 ring-primary/40 shadow-md" : ""}`}>
      <button {...attributes} {...listeners} type="button" className="shrink-0 cursor-grab touch-none rounded p-1 text-text-muted hover:bg-sidebar hover:text-primary active:cursor-grabbing" title={translate("Drag to reorder directory")} aria-label={translate("Drag to reorder directory")}>
        <span className="material-symbols-outlined text-[18px]">drag_indicator</span>
      </button>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect}>
        <span className="block truncate font-medium text-text-main">{model.displayName}</span>
        <code className="block truncate text-xs text-text-muted">{model.publicName}</code>
      </button>
      <span className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
        <span>{model.enabledProviderCount}/{model.providerCount} {translate("channels")}</span>
        <span className={model.enabled ? "text-green-600" : "text-text-muted"}>{statusLabel(model)}</span>
      </span>
      <button type="button" className="shrink-0 rounded p-1 text-text-muted hover:bg-sidebar hover:text-primary" onClick={onEdit} title={translate("Edit standard model")} aria-label={translate("Edit standard model")}>
        <span className="material-symbols-outlined text-[17px]">edit</span>
      </button>
      <button type="button" className="shrink-0 rounded p-1 text-text-muted hover:bg-red-500/10 hover:text-red-600" onClick={onDelete} title={model.catalogVersion ? translate("Remove local registration") : translate("Delete standard model")} aria-label={model.catalogVersion ? translate("Remove local registration") : translate("Delete standard model")}>
        <span className="material-symbols-outlined text-[17px]">delete</span>
      </button>
    </div>
  );
}

function StandardBindingItem({ id, index, binding, onEdit, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.45 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  const mappingIds = (binding.mappings || []).map((mapping) => mapping.upstreamModelId).filter(Boolean);
  const displayName = binding.data?.selectorName || mappingIds[0] || translate("Model not set");
  const upstreamModelId = mappingIds[0] || translate("Upstream model not set");

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex min-w-0 items-center gap-2 px-3 py-2 transition-colors ${isDragging ? "bg-primary/10 ring-1 ring-primary/40 shadow-md" : "hover:bg-sidebar/50"}`}
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="shrink-0 cursor-grab touch-none rounded p-1 text-text-muted hover:bg-sidebar hover:text-primary active:cursor-grabbing"
        title={translate("Drag to reorder fallback")}
        aria-label={translate("Drag to reorder fallback")}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="9" cy="4" r="2" /><circle cx="15" cy="4" r="2" />
          <circle cx="9" cy="12" r="2" /><circle cx="15" cy="12" r="2" />
          <circle cx="9" cy="20" r="2" /><circle cx="15" cy="20" r="2" />
        </svg>
      </button>
      <span className="w-5 shrink-0 text-center text-xs font-semibold text-text-muted">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <span className="block truncate font-medium text-text-main">{displayName}</span>
        <code className="block truncate text-xs text-text-muted">{upstreamModelId}</code>
      </div>
      <span className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
        <span className="text-primary">{binding.providerId}</span>
        <span>{binding.connectionCount} {translate("active connections")}</span>
      </span>
      <button type="button" className="shrink-0 rounded p-1 text-text-muted hover:bg-sidebar hover:text-primary" onClick={onEdit} title={translate("Edit provider model")} aria-label={translate("Edit provider model")}>
        <span className="material-symbols-outlined text-[17px]">edit</span>
      </button>
      <button type="button" className="shrink-0 rounded p-1 text-text-muted hover:bg-red-500/10 hover:text-red-600" onClick={onRemove} title={translate("Delete provider model")} aria-label={translate("Delete provider model")}>
        <span className="material-symbols-outlined text-[18px]">delete</span>
      </button>
    </div>
  );
}
