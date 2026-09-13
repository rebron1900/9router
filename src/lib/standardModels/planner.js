function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}

const REQUEST_FORMAT_ALIASES = {
  "openai-images": ["openai-images", "openai-image", "openai", "images"],
};

const OPERATION_ALIASES = {
  image_generation: ["image_generation", "images.generate", "generation", "generate", "text_to_image"],
  image_edit: ["image_edit", "images.edit", "edit", "image_to_image", "inpainting"],
};

function requestedValues(requested, aliases) {
  const values = Array.isArray(requested) ? requested : [requested];
  return values.flatMap((value) => aliases[value] || [value]).filter((value) => value !== null && value !== undefined && value !== "");
}

function matchesScope(values, requested, aliases = {}) {
  const list = asArray(values);
  if (list.length === 0 || requested === null || requested === undefined || requested === "") return true;
  return requestedValues(requested, aliases).some((value) => list.includes(value));
}

function selectMappings(binding, requestFormat, operation) {
  const mappings = Array.isArray(binding.mappings) ? binding.mappings : [];
  return mappings
    .filter((mapping) => mapping.enabled !== false)
    .filter((mapping) => matchesScope(mapping.requestFormats, requestFormat, REQUEST_FORMAT_ALIASES))
    .filter((mapping) => !operation || matchesScope(mapping.operations, operation, OPERATION_ALIASES))
    .sort((a, b) => (Number(a.mappingPriority) || 1) - (Number(b.mappingPriority) || 1));
}

function requiredCapabilitiesMatch(model, mapping) {
  const required = model?.requiredCapabilities || {};
  const override = mapping?.capabilityOverrides || {};
  for (const [name, requiredValue] of Object.entries(required)) {
    if (requiredValue !== true) continue;
    if (override[name] === false) return false;
  }
  return true;
}

/**
 * Build a deterministic, no-network routing preview. The same planner is
 * intended to be reused by request execution once the execution coordinator
 * is introduced.
 */
export function planStandardModelCandidates({
  model,
  bindings = [],
  requestFormat = null,
  operation = null,
  requireConfiguredProvider = false,
} = {}) {
  const candidates = [];
  const excluded = [];
  for (const binding of bindings) {
    const provider = binding.providerId;
    if (binding.enabled === false) {
      excluded.push({ providerId: provider, reason: "binding_disabled" });
      continue;
    }
    if (model?.enabled === false) {
      excluded.push({ providerId: provider, reason: "standard_model_disabled" });
      continue;
    }
    if (requireConfiguredProvider && !binding.configured) {
      excluded.push({ providerId: provider, reason: "no_active_connection" });
      continue;
    }

    const scopedMappings = selectMappings(binding, requestFormat, operation);
    const mappings = scopedMappings.filter((mapping) => requiredCapabilitiesMatch(model, mapping));
    if (mappings.length === 0) {
      excluded.push({
        providerId: provider,
        reason: scopedMappings.length > 0
          ? "capability_mismatch"
          : (requestFormat || operation ? "no_matching_mapping" : "no_mapping"),
      });
      continue;
    }

    for (const mapping of mappings) {
      candidates.push({
        bindingId: binding.id,
        providerId: provider,
        upstreamModelId: mapping.upstreamModelId,
        requestFormats: asArray(mapping.requestFormats),
        operations: asArray(mapping.operations),
        priority: Math.max(1, Number(binding.priority) || 1),
        mappingId: mapping.id,
        mappingPriority: Math.max(1, Number(mapping.mappingPriority) || 1),
        configured: !!binding.configured,
        connectionCount: Number(binding.connectionCount) || 0,
        // Keep mapping-level capability declarations attached to this
        // candidate. The execution layer uses them as request-scoped
        // overrides; they must not be stored in global provider state because
        // standard models can point at the same upstream with different
        // contracts.
        capabilityOverrides: mapping.capabilityOverrides || {},
        // The standard model's own identity + declared capabilities. The
        // execution layer feeds these into the shared capability resolver so
        // the runtime sees the same catalog/DB layers as /v1/models, instead of
        // resolving the upstream model purely from the static provider table.
        publicName: model?.publicName || null,
        standardModelCapabilities:
          model?.capabilities && typeof model.capabilities === "object" && !Array.isArray(model.capabilities)
            ? model.capabilities
            : null,
      });
    }
  }

  candidates.sort((a, b) => a.priority - b.priority
    || a.providerId.localeCompare(b.providerId)
    || a.mappingPriority - b.mappingPriority
    || a.upstreamModelId.localeCompare(b.upstreamModelId));
  return {
    standardModelId: model?.id || null,
    publicName: model?.publicName || null,
    requestFormat: requestFormat || null,
    operation: operation || null,
    candidates,
    excluded,
    priorityGroups: [...new Set(candidates.map((candidate) => candidate.priority))],
  };
}
