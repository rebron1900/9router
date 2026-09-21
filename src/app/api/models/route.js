import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, getCustomModels } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getModelType } from "open-sse/config/providerModels.js";
import { getUnifiedProviderModels } from "@/lib/modelCatalog";

function normalizeRequestedKind(value) {
  const kind = String(value || "llm").trim();
  return kind === "chat" ? "llm" : kind;
}

function modelKindOf(model) {
  return getModelType(model?.provider, model?.model) || "llm";
}

function matchesRequestedKind(kind, requestedKind) {
  return requestedKind === "all" || kind === requestedKind;
}

// GET /api/models - Get models with aliases
// includeDisabled is used by the dashboard model-control modal so it can
// display models that are currently hidden and make them available again.
export async function GET(request) {
  try {
    const searchParams = new URL(request?.url || "http://localhost/api/models").searchParams;
    const includeDisabled = searchParams.get("includeDisabled") === "true";
    const requestedKind = normalizeRequestedKind(searchParams.get("kind"));
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();

    // The default catalog is for chat models. The model-control dialog asks
    // for kind=all so it can present each service type in its own tab.
    const models = AI_MODELS
      .map((m) => {
        const kind = modelKindOf(m);
        const fullModel = `${m.provider}/${m.model}`;
        const providerAlias = getProviderAlias(m.provider) || m.provider;
        const routedModel = `${providerAlias}/${m.model}`;
        const disabledIds = new Set([
          ...(disabled[providerAlias] || []),
          ...(disabled[m.provider] || []),
        ]);
        const c = getCapabilitiesForModel(m.provider, m.model);
        return {
          ...m,
          fullModel,
          routedModel,
          providerAlias,
          kind,
          disabled: disabledIds.has(m.model),
          alias: modelAliases[fullModel] || m.model,
          caps: {
            vision: c.vision,
            search: c.search,
            reasoning: c.reasoning,
            contextWindow: c.contextWindow,
            maxOutput: c.maxOutput,
          },
        };
      })
      .filter((m) => matchesRequestedKind(m.kind, requestedKind))
      .filter((m) => includeDisabled || !m.disabled);

    // Local provider catalogs are durable discovery results. Stale entries remain
    // available for visibility management, but are not advertised as active models.
    const catalogModels = await getUnifiedProviderModels();
    const catalogFullModels = new Set();
    for (const catalog of catalogModels) {
      if (catalog?.stale === true && !includeDisabled) continue;
      const providerId = catalog.providerId;
      const providerAlias = catalog.providerAlias || getProviderAlias(providerId) || providerId;
      const id = catalog.modelId;
      const kind = catalog.kind || "llm";
      if (!matchesRequestedKind(kind, requestedKind)) continue;
      const fullModel = `${providerAlias}/${id}`;
      catalogFullModels.add(fullModel);
      const disabledIds = new Set([
        ...(disabled[providerAlias] || []),
        ...(disabled[providerId] || []),
      ]);
      if (!includeDisabled && disabledIds.has(id)) continue;
      const c = getCapabilitiesForModel(providerId, id);
      models.push({
        provider: providerId,
        model: id,
        name: catalog.name || id,
        catalogStale: catalog.stale === true,
        fullModel,
        routedModel: fullModel,
        providerAlias,
        kind,
        disabled: disabledIds.has(id),
        alias: modelAliases[fullModel] || id,
        caps: {
          vision: c.vision,
          search: c.search,
          reasoning: c.reasoning,
          contextWindow: c.contextWindow,
          maxOutput: c.maxOutput,
          ...(catalog.capabilities || {}),
        },
      });
    }

    // Custom models ride along; their stored caps override the name heuristic
    const seenFull = new Set(models.map((m) => m.fullModel));
    const customModels = (await getCustomModels()).filter((m) => {
      if (!m?.id) return false;
      const kind = m.kind || m.type || "llm";
      return matchesRequestedKind(kind, requestedKind)
        && !seenFull.has(`${m.providerAlias}/${m.id}`)
        && !catalogFullModels.has(`${m.providerAlias}/${m.id}`);
    });
    for (const m of customModels) {
      const kind = m.kind || m.type || "llm";
      const fullModel = `${m.providerAlias}/${m.id}`;
      const c = getCapabilitiesForModel(m.providerAlias, m.id);
      const providerAlias = m.providerAlias;
      const disabledIds = new Set([
        ...(disabled[providerAlias] || []),
        ...(disabled[m.provider] || []),
      ]);
      const isDisabled = disabledIds.has(m.id);
      if (!includeDisabled && isDisabled) continue;
      models.push({
        provider: m.providerAlias,
        model: m.id,
        name: m.name || m.id,
        fullModel,
        routedModel: fullModel,
        providerAlias,
        kind,
        disabled: isDisabled,
        alias: modelAliases[fullModel] || m.id,
        caps: {
          vision: c.vision,
          search: c.search,
          reasoning: c.reasoning,
          contextWindow: c.contextWindow,
          maxOutput: c.maxOutput,
          ...(m.caps || {}),
        },
      });
    }

    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();

    // Check if alias already exists for different model
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    await setModelAlias(model, alias);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
