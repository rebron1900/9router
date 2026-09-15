"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal, Toggle } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import {
  AI_PROVIDERS,
  getProviderAlias,
} from "@/shared/constants/providers";
import {
  createComboVisibilityGroup,
  createStandardModelVisibilityGroup,
} from "@/lib/standardModels/visibility";
import { onLocaleChange, translate } from "@/i18n/runtime";

const LIVE_CATALOG_PROVIDERS = new Set(["cursor", "cline", "clinepass"]);
const MODEL_KIND_TABS = [
  { key: "llm", label: "LLM / Chat", icon: "chat" },
  { key: "tts", label: "TTS", icon: "record_voice_over" },
  { key: "stt", label: "STT", icon: "mic" },
  { key: "embedding", label: "Embedding", icon: "data_array" },
  { key: "image", label: "Image", icon: "brush" },
];
const MODEL_VISIBILITY_TABS = [
  ...MODEL_KIND_TABS.map((tab) => ({ ...tab, source: "providers" })),
  { key: "standard", label: "Standard Model Routing", icon: "hub", source: "standard" },
  { key: "combos", label: "Combo & Vision Adapter", icon: "layers", source: "combos" },
];

function modelIdOf(model) {
  return String(model?.model || model?.id || "").trim();
}

function providerKeyOf(model) {
  const provider = model?.providerAlias || model?.provider || "";
  return String(getProviderAlias(provider) || provider).trim();
}

function modelDisplayName(model, id) {
  return String(model?.name || model?.displayName || id).trim() || id;
}

function modelKindOf(model) {
  const kind = model?.kind || model?.type || "llm";
  return String(kind).trim() || "llm";
}

function addModel(groups, model, disabledByProvider) {
  const id = modelIdOf(model);
  const storageAlias = providerKeyOf(model);
  if (!id || !storageAlias) return;
  const kind = modelKindOf(model);

  const providerId = String(model?.provider || storageAlias).trim();
  const disabledIds = new Set([
    ...(disabledByProvider[storageAlias] || []),
    ...(disabledByProvider[providerId] || []),
  ]);
  const group = groups.get(storageAlias) || {
    key: storageAlias,
    storageAlias,
    providerId,
    name: storageAlias,
    models: [],
  };

  if (group.models.some((entry) => entry.id === id && entry.kind === kind)) {
    return;
  }

  group.models.push({
    id,
    name: modelDisplayName(model, id),
    kind,
    disabled: Boolean(model?.disabled) || disabledIds.has(id),
  });
  groups.set(storageAlias, group);
}

function providerInfoFor(group, providerNodes) {
  const node = providerNodes.find(
    (entry) =>
      entry?.id === group.providerId ||
      entry?.id === group.storageAlias ||
      entry?.prefix === group.storageAlias,
  );
  if (node) {
    return {
      name: node.name || group.storageAlias,
      providerId: node.id || group.providerId,
      color: "#10A37F",
      textIcon: "OC",
    };
  }

  const direct = AI_PROVIDERS[group.providerId] || AI_PROVIDERS[group.storageAlias];
  const byAlias =
    direct ||
    Object.values(AI_PROVIDERS).find(
      (provider) => provider.alias === group.storageAlias,
    );

  return {
    name: byAlias?.name || group.storageAlias,
    providerId: byAlias?.id || group.providerId,
    color: byAlias?.color,
    textIcon: byAlias?.textIcon,
  };
}

function buildGroups({ models, standardModels, combos, disabledByProvider, connections, providerNodes }) {
  const groups = new Map();
  const configuredProviderKeys = new Set();
  const markConfiguredProvider = (providerId) => {
    if (!providerId) return;
    const key = String(providerId).trim();
    if (!key) return;
    configuredProviderKeys.add(key);
    configuredProviderKeys.add(getProviderAlias(key));
  };

  for (const connection of connections) {
    if (!AI_PROVIDERS[connection?.provider]?.hidden) {
      markConfiguredProvider(connection?.provider);
    }
  }
  for (const node of providerNodes) {
    if (!AI_PROVIDERS[node?.id]?.hidden) {
      markConfiguredProvider(node?.id);
    }
  }

  // Providers marked noAuth are system-configured providers. They do not
  // create a connection row, so relying only on connections would hide their
  // built-in models (for example OpenCode Free) from this page.
  for (const [providerId, provider] of Object.entries(AI_PROVIDERS)) {
    if (provider?.noAuth && !provider?.hidden) {
      markConfiguredProvider(providerId);
    }
  }

  for (const model of models) {
    addModel(groups, model, disabledByProvider);
  }

  // A disabled live/custom model may not be part of the static /api/models
  // catalog. Keep it visible so it can be enabled again from this modal.
  for (const [providerAlias, ids] of Object.entries(disabledByProvider)) {
    for (const id of Array.isArray(ids) ? ids : []) {
      addModel(
        groups,
        { provider: providerAlias, providerAlias, model: id, name: id, disabled: true },
        disabledByProvider,
      );
    }
  }

  // Compatible providers can store an explicit model list on the connection.
  // Include those entries even when the upstream endpoint is unavailable.
  for (const connection of connections) {
    if (AI_PROVIDERS[connection?.provider]?.hidden) continue;
    const configured = connection?.providerSpecificData?.enabledModels;
    if (!Array.isArray(configured)) continue;
    for (const rawModel of configured) {
      const id = String(
        rawModel?.id || rawModel?.model || rawModel?.name || rawModel || "",
      ).trim();
      if (!id) continue;
      addModel(
        groups,
        {
          provider: connection.provider,
          providerAlias: getProviderAlias(connection.provider),
          model: id,
          name: rawModel?.name || rawModel?.displayName || id,
        },
        disabledByProvider,
      );
    }
  }

  const providerGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      source: "providers",
      ...providerInfoFor(group, providerNodes),
      models: [...group.models].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    }))
    .filter(
      (group) =>
        group.models.length > 0 &&
        (configuredProviderKeys.has(group.key) ||
          configuredProviderKeys.has(group.providerId)),
    )
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const standardModelGroup = createStandardModelVisibilityGroup(
    standardModels,
    disabledByProvider,
  );
  const comboGroup = createComboVisibilityGroup(combos, disabledByProvider);
  return [
    ...(standardModelGroup ? [standardModelGroup] : []),
    ...(comboGroup ? [comboGroup] : []),
    ...providerGroups,
  ];
}

async function readJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return null;
  return response.json();
}

export default function ModelControlModal({
  isOpen,
  onClose,
  connections = [],
  providerNodes = [],
  embedded = false,
}) {
  const [, refreshLocale] = useState(0);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("llm");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState({});
  const [pending, setPending] = useState(() => new Set());
  const [reloadToken, setReloadToken] = useState(0);
  const activeCategory = activeTab === "standard" || activeTab === "combos" ? activeTab : "providers";
  const activeKind = activeCategory === "providers" ? activeTab : "llm";

  useEffect(() => onLocaleChange(() => refreshLocale((value) => value + 1)), [refreshLocale]);

  useEffect(() => {
    if (!embedded && !isOpen) return undefined;

    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError("");
      try {
          const [modelsData, disabledData, standardModelsData, combosData] = await Promise.all([
            readJson("/api/models?includeDisabled=true&kind=all"),
            readJson("/api/models/disabled"),
            readJson("/api/models/standard"),
            readJson("/api/combos"),
          ]);
        if (!modelsData || !disabledData || !standardModelsData || !combosData) {
          throw new Error("Failed to load model availability");
        }

        const disabledByProvider = disabledData.disabled || {};
        const models = Array.isArray(modelsData.models) ? [...modelsData.models] : [];
        const liveConnections = connections.filter((connection) =>
          LIVE_CATALOG_PROVIDERS.has(connection?.provider),
        );
        const liveResults = await Promise.allSettled(
          liveConnections.map(async (connection) => {
            const data = await readJson(`/api/providers/${connection.id}/models`);
            return {
              connection,
              models: Array.isArray(data?.models) ? data.models : [],
            };
          }),
        );
        for (const result of liveResults) {
          if (result.status !== "fulfilled") continue;
          for (const model of result.value.models) {
              models.push({
                ...model,
                provider: result.value.connection.provider,
                providerAlias: getProviderAlias(result.value.connection.provider),
                kind: modelKindOf(model),
              });
          }
        }

        if (cancelled) return;
        const nextGroups = buildGroups({
          models,
          standardModels: standardModelsData.models,
          combos: combosData.combos,
          disabledByProvider,
          connections,
          providerNodes,
        });
        setGroups(nextGroups);
        setExpanded(
          Object.fromEntries(nextGroups.map((group) => [group.key, false])),
        );
      } catch (loadError) {
        if (!cancelled) {
          console.error("Error loading model availability:", loadError);
          setError("Unable to load model availability");
          setGroups([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [isOpen, embedded, connections, providerNodes, reloadToken]);

  const categoryGroups = useMemo(() => groups
    .filter((group) => group.source === activeCategory)
    .map((group) => ({
      ...group,
      models: activeCategory === "providers"
        ? group.models.filter((model) => model.kind === activeKind)
        : group.models,
    }))
    .filter((group) => group.models.length > 0), [groups, activeCategory, activeKind]);

  const normalizedQuery = query.trim().toLowerCase();
  const localizedGroups = categoryGroups.map((group) => ({
    ...group,
    displayName: group.translatableName ? translate(group.name) : group.name,
  }));
  const visibleGroups = !normalizedQuery
    ? localizedGroups
    : localizedGroups
      .map((group) => ({
        ...group,
        models: group.models.filter(
          (model) =>
            group.displayName.toLowerCase().includes(normalizedQuery) ||
            model.name.toLowerCase().includes(normalizedQuery) ||
            model.id.toLowerCase().includes(normalizedQuery),
        ),
      }))
      .filter((group) => group.models.length > 0);

  const kindCounts = useMemo(() => Object.fromEntries(
    MODEL_KIND_TABS.map(({ key }) => [
      key,
        groups.filter((group) => group.source === "providers").reduce(
        (count, group) => count + group.models.filter((model) => model.kind === key).length,
        0,
      ),
    ]),
  ), [groups]);

  const setPendingKey = (key, value) => {
    setPending((current) => {
      const next = new Set(current);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const updateGroup = (groupKey, updateModel) => {
    setGroups((current) =>
      current.map((group) =>
        group.key === groupKey
          ? { ...group, models: group.models.map(updateModel) }
          : group,
      ),
    );
  };

  const setModelEnabled = async (group, model, enabled) => {
    const pendingKey = `${group.storageAlias}:${model.kind}:${model.id}`;
    if (pending.has(pendingKey)) return;
    setPendingKey(pendingKey, true);
    try {
      if (enabled) {
        const aliases = [...new Set([group.storageAlias, group.providerId])];
        const responses = await Promise.all(
          aliases.map((alias) =>
            fetch(
              `/api/models/disabled?providerAlias=${encodeURIComponent(alias)}&id=${encodeURIComponent(model.id)}`,
              { method: "DELETE" },
            ),
          ),
        );
        if (responses.some((entry) => !entry.ok)) {
          throw new Error("Failed to enable model");
        }
      } else {
        const response = await fetch("/api/models/disabled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerAlias: group.storageAlias, ids: [model.id] }),
        });
        if (!response.ok) throw new Error("Failed to disable model");
      }
      updateGroup(group.key, (entry) =>
        entry.id === model.id && entry.kind === model.kind
          ? { ...entry, disabled: !enabled }
          : entry,
      );
    } catch (updateError) {
      console.error("Error updating model availability:", updateError);
      setError("Unable to update model availability");
    } finally {
      setPendingKey(pendingKey, false);
    }
  };

  const setProviderEnabled = async (group, enabled) => {
    const pendingKey = `provider:${group.storageAlias}`;
    if (pending.has(pendingKey)) return;
    setPendingKey(pendingKey, true);
    try {
      if (enabled) {
        const aliases = [...new Set([group.storageAlias, group.providerId])];
        const modelIds = [...new Set(group.models.map((model) => model.id))];
        const responses = await Promise.all(
          aliases.flatMap((alias) => modelIds.map((id) =>
            fetch(
              `/api/models/disabled?providerAlias=${encodeURIComponent(alias)}&id=${encodeURIComponent(id)}`,
              { method: "DELETE" },
            ),
          )),
        );
        if (responses.some((entry) => !entry.ok)) {
          throw new Error("Failed to enable provider models");
        }
      } else {
        const response = await fetch("/api/models/disabled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerAlias: group.storageAlias,
            ids: group.models.map((model) => model.id),
          }),
        });
        if (!response.ok) throw new Error("Failed to disable provider models");
      }
      updateGroup(group.key, (model) => (
        group.source === "providers" && model.kind !== activeKind
          ? model
          : { ...model, disabled: !enabled }
      ));
    } catch (updateError) {
      console.error("Error updating provider availability:", updateError);
      setError("Unable to update provider availability");
    } finally {
      setPendingKey(pendingKey, false);
    }
  };

  const content = (
      <div className="flex flex-col gap-4">
        <section className="border-b border-border/70">
          <div
            role="tablist"
            aria-label={translate("Model categories")}
            className="flex gap-0.5 overflow-x-auto"
          >
            {MODEL_VISIBILITY_TABS.map((tab) => {
              const active = activeTab === tab.key;
              const count = tab.source === "providers"
                ? kindCounts[tab.key] || 0
                : groups
                  .filter((group) => group.source === tab.source)
                  .reduce((total, group) => total + group.models.length, 0);
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-label={translate(tab.label)}
                  title={translate(tab.label)}
                  onClick={() => {
                    setActiveTab(tab.key);
                    setQuery("");
                  }}
                  className={`relative flex min-h-[44px] w-10 shrink-0 items-center justify-center gap-1.5 px-2 py-2 text-[11px] font-medium transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:transition-opacity sm:w-auto sm:justify-start sm:px-3 ${
                    active
                      ? "text-primary after:bg-primary after:opacity-100"
                      : "text-text-muted after:opacity-0 hover:text-text-main"
                  }`}
                >
                  <span className="material-symbols-outlined text-[15px]">
                    {tab.icon}
                  </span>
                  <span className="hidden whitespace-nowrap sm:inline">{translate(tab.label)}</span>
                  <span className="hidden rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] tabular-nums text-text-muted sm:inline-flex">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1 text-sm text-text-muted">
            {translate("This setting controls discovery only. Hidden models can still be called by explicit API requests, Combo, or standard-model routes. Changes apply immediately.")}
          </p>
          <div className="flex shrink-0 gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={translate("Search providers or models")}
              aria-label={translate("Search providers or models")}
              className="h-8 w-full rounded-lg border border-border bg-bg px-3 text-xs text-text-main outline-none focus:border-brand-500 sm:w-56"
            />
            <Button
              size="sm"
              variant="secondary"
              icon="refresh"
              onClick={() => setReloadToken((value) => value + 1)}
              disabled={loading}
              title={translate("Refresh model list")}
              aria-label={translate("Refresh model list")}
            />
          </div>
        </div>

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <span>{translate(error)}</span>
            <Button size="sm" variant="ghost" onClick={() => setError("")}>{translate("Dismiss")}</Button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-text-muted">
            <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
            {translate("Loading models...")}
          </div>
        ) : visibleGroups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-text-muted">
            {translate(activeCategory === "providers" ? "No configured providers have models" : "No visible models in this group")}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {visibleGroups.map((group) => {
              const enabledCount = group.models.filter((model) => !model.disabled).length;
              const allEnabled = enabledCount === group.models.length;
              const anyEnabled = enabledCount > 0;
              const providerPending = pending.has(`provider:${group.storageAlias}`);
              const isExpanded = query.trim()
                ? true
                : (expanded[group.key] ?? false);
              return (
                <section key={group.key} className="overflow-hidden rounded-xl border border-border bg-bg/40">
                  <div className="flex items-center gap-3 px-3 py-3">
                    <ProviderIcon
                      providerId={group.iconProviderId ?? group.providerId}
                      alt={group.displayName}
                      size={28}
                      className="shrink-0 rounded-lg object-contain"
                      fallbackText={group.textIcon || group.displayName.slice(0, 2).toUpperCase()}
                      fallbackColor={group.color}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-text-main">
                        {group.displayName}
                      </p>
                      <p className="text-xs text-text-muted">
                        {enabledCount}/{group.models.length} {translate("visible")}
                        {!allEnabled && anyEnabled ? ` · ${translate("partially visible")}` : ""}
                      </p>
                    </div>
                    <Toggle
                      size="sm"
                      checked={anyEnabled}
                      disabled={providerPending}
                      onChange={(enabled) => setProviderEnabled(group, enabled)}
                      label={translate(allEnabled ? "All" : anyEnabled ? "Some" : "Hidden")}
                    />
                    <button
                      type="button"
                      className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main"
                      onClick={() =>
                        setExpanded((current) => ({ ...current, [group.key]: !isExpanded }))
                      }
                      aria-label={`${translate(isExpanded ? "Collapse" : "Expand")} ${group.displayName}`}
                    >
                      <span className="material-symbols-outlined text-[18px]">
                        {isExpanded ? "expand_less" : "expand_more"}
                      </span>
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-border px-3 py-2">
                      {group.models.map((model) => {
                        const modelPending = pending.has(`${group.storageAlias}:${model.kind}:${model.id}`);
                        return (
                          <div key={model.id} className="flex items-center gap-3 border-b border-border/50 py-2 last:border-0">
                            <div className="min-w-0 flex-1">
                              <p className={`truncate text-sm ${model.disabled ? "text-text-muted" : "text-text-main"}`}>
                                {model.name}
                              </p>
                              {model.name !== model.id && (
                                <p className="truncate text-[11px] text-text-muted">{model.id}</p>
                              )}
                            </div>
                            <Toggle
                              size="sm"
                              checked={!model.disabled}
                              disabled={modelPending || providerPending}
                              onChange={(enabled) => setModelEnabled(group, model, enabled)}
                              label={translate(model.disabled ? "Hidden" : "Visible")}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
  );

  if (embedded) return content;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={translate("Model visibility")}
      size="full"
      showTrafficLights
      footer={
        <Button variant="secondary" onClick={onClose}>
          {translate("Close")}
        </Button>
      }
    >
      {content}
    </Modal>
  );
}

ModelControlModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  connections: PropTypes.arrayOf(PropTypes.object),
  providerNodes: PropTypes.arrayOf(PropTypes.object),
  embedded: PropTypes.bool,
};
