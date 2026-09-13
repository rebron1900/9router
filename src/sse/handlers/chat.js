import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings, getStandardModelByName, getStandardModelBindings } from "@/lib/localDb";
import { createCapabilityResolver, loadCustomModelCapabilityOverrides, resolveCapabilities } from "@/lib/modelCapabilities";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { isTransientCommandCodeError } from "open-sse/executors/commandcode.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { detectFormat } from "open-sse/services/provider.js";
import { getCapabilitiesForModel, mergeCapabilities } from "open-sse/providers/capabilities.js";
import { planStandardModelCandidates } from "@/lib/standardModels/planner";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import {
  STANDARD_ROUTE_DEFAULTS,
  buildStandardRouteErrorResponse,
  classifyStandardRouteFailure,
  createStandardRouteBudget,
  getStandardProviderHealthKey,
  getStandardProviderHealth,
  recordStandardProviderFailure,
  recordStandardProviderSuccess,
  getStandardResponseAffinity,
  recordStandardResponseAffinity,
} from "@/lib/standardModels/runtime";

const COMMANDCODE_TRANSIENT_RETRY_DELAY_MS = 250;

function waitForCommandCodeRetry(signal, delayMs = COMMANDCODE_TRANSIENT_RETRY_DELAY_MS) {
  if (!delayMs || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = setTimeout(done, delayMs);
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    };
    function done() {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * Keep a standard-route deadline alive for the entire returned Response body.
 * A Response is committed before its ReadableStream finishes, so disposing
 * the budget at the routing boundary would cancel an in-flight upstream body
 * immediately after its first chunk. The wrapper owns cleanup on EOF, cancel,
 * or stream error and preserves the deferred forced-JSON telemetry contract.
 */
export function withStandardRouteBudgetResponse(response, budget) {
  if (!budget || !response?.body?.getReader) {
    budget?.dispose?.();
    return response;
  }

  const reader = response.body.getReader();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    budget.dispose?.();
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          dispose();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        dispose();
        try { await reader.cancel(error); } catch { /* upstream already closed */ }
        controller.error(error);
      }
    },
    async cancel(reason) {
      dispose();
      try { await reader.cancel(reason); } catch { /* upstream already closed */ }
    },
  });
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  if (response.__9routerDeferredOutcome) {
    try {
      Object.defineProperty(wrapped, "__9routerDeferredOutcome", {
        value: response.__9routerDeferredOutcome,
        configurable: true,
      });
    } catch { /* Response implementations may be sealed */ }
  }
  return wrapped;
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  // Load user-defined model capabilities once for this request. The resolver
  // is synchronous after this point, so every combo/fallback candidate sees
  // the same snapshot without introducing DB reads into open-sse's hot path.
  const customCapabilityOverrides = await loadCustomModelCapabilityOverrides();
  const capabilityResolver = createCapabilityResolver(customCapabilityOverrides);
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // A standard model is a provider-neutral public name. Explicit provider/model
  // requests continue through the legacy path unchanged.
  const standardRouting = settings.standardModelRouting || {};
  if (standardRouting.enabled === true && !modelStr.includes("/")) {
    const standardModel = await getStandardModelByName(modelStr);
    if (standardModel) {
      return handleStandardModelChat({
        body,
        modelStr,
        standardModel,
        requiredCapabilities,
        clientRawRequest,
        request,
        apiKey,
        settings,
        capabilityResolver,
      });
    }
  }

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings, capabilityResolver);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null, capabilityResolver);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, capabilityResolver),
        adapterAdded,
        capabilityResolver
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      capabilityResolver
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings, capabilityResolver);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, capabilityResolver),
        adapterAdded,
        capabilityResolver
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings),
      capabilityResolver
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, null, capabilityResolver);
}

/**
 * Resolve a standard model to ordered provider/model candidates, then reuse
 * the existing combo fallback engine for provider and account failover.
 */
async function handleStandardModelChat({ body, modelStr, standardModel, requiredCapabilities, clientRawRequest, request, apiKey, settings, capabilityResolver }) {
  const bindings = await getStandardModelBindings(standardModel.id);
  const requestFormat = request?.url
    ? (detectFormatByEndpoint(new URL(request.url).pathname, body) || detectFormat(body))
    : detectFormat(body);
  const modelForPlanning = {
    ...standardModel,
    requiredCapabilities: Object.fromEntries([...requiredCapabilities].map((capability) => [capability, true])),
  };
  const policy = {
    ...(settings.standardModelRouting?.defaultPolicy || {}),
    ...(standardModel.policy || {}),
  };
  delete policy.selection;
  const plan = planStandardModelCandidates({
    model: modelForPlanning,
    bindings,
    requestFormat,
    requireConfiguredProvider: true,
  });

  const previousResponseId = typeof body?.previous_response_id === "string"
    ? body.previous_response_id.trim()
    : "";
  const responseAffinity = previousResponseId ? getStandardResponseAffinity(previousResponseId) : null;
  if (previousResponseId && !responseAffinity) {
    return buildStandardRouteErrorResponse({
      status: 409,
      message: `Cannot continue response ${previousResponseId}: its provider affinity is no longer available`,
      publicModel: modelStr,
      code: "response_affinity_unknown",
      retryable: false,
    });
  }
  if (responseAffinity && responseAffinity.standardModelId !== standardModel.id) {
    return buildStandardRouteErrorResponse({
      status: 409,
      message: `Response ${previousResponseId} belongs to another standard model`,
      publicModel: modelStr,
      code: "response_affinity_model_mismatch",
      retryable: false,
    });
  }
  const affinityCandidate = responseAffinity
    ? plan.candidates.find((candidate) => candidate.providerId === responseAffinity.providerId
      && candidate.upstreamModelId === responseAffinity.upstreamModelId)
    : null;
  if (responseAffinity && !affinityCandidate) {
    return buildStandardRouteErrorResponse({
      status: 409,
      message: `Provider affinity for response ${previousResponseId} is not configured for ${modelStr}`,
      publicModel: modelStr,
      code: "response_affinity_unavailable",
      retryable: false,
    });
  }

  if (plan.candidates.length === 0) {
    const reason = plan.excluded[0]?.reason || "no_provider_mapping";
    log.warn("ROUTER", `Standard model "${modelStr}" has no available provider (${reason})`);
    return buildStandardRouteErrorResponse({
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      message: `No available provider for standard model: ${modelStr}`,
      publicModel: modelStr,
      code: "no_provider_mapping",
      retryable: false,
      failures: plan.excluded.map((item) => ({ provider: item.providerId, category: item.reason, retryable: false })),
    });
  }

  // Health is process-local by design in this phase. A cooled provider is
  // excluded for this standard model/upstream mapping, while an all-cooled
  // route still probes the configured candidates to avoid a hard outage.
  const healthyCandidates = plan.candidates.filter((candidate) => {
    const key = getStandardProviderHealthKey(standardModel.id, candidate.providerId, candidate.upstreamModelId);
    return !getStandardProviderHealth(key);
  });
  const routableCandidates = affinityCandidate
    ? [affinityCandidate]
    : (healthyCandidates.length > 0 ? healthyCandidates : plan.candidates);
  if (healthyCandidates.length !== plan.candidates.length) {
    log.info("ROUTER", `Standard model "${modelStr}" skipped ${plan.candidates.length - healthyCandidates.length} provider health cooldown(s)`);
  }

  const maxAttempts = Number(policy.maxProviderAttempts);
  const candidates = affinityCandidate || policy.fallbackStrategy === "none"
    ? routableCandidates.slice(0, 1)
    : Number.isFinite(maxAttempts) && maxAttempts > 0
    ? routableCandidates.slice(0, Math.floor(maxAttempts))
    : routableCandidates;
  const providerModels = candidates.map((candidate) => `${candidate.providerId}/${candidate.upstreamModelId}`);
  const maxGenerationAttempts = Number(policy.maxGenerationAttempts);
  const routeBudget = createStandardRouteBudget({
    maxAttempts: Number.isFinite(maxGenerationAttempts) && maxGenerationAttempts > 0
      ? maxGenerationAttempts
      : STANDARD_ROUTE_DEFAULTS.maxGenerationAttempts,
    timeoutMs: Number(policy.maxRouteDurationMs || policy.timeoutMs) || STANDARD_ROUTE_DEFAULTS.maxRouteDurationMs,
    signal: request?.signal,
  });
  const maxAccountAttemptsPerProvider = Number(policy.maxAccountAttemptsPerProvider);
  const failures = [];

  log.info("ROUTER", `Standard model "${modelStr}" → ${providerModels.join(", ")}`);
  let routedResponse;
  try {
    routedResponse = await handleComboChat({
    body,
    models: providerModels,
    handleSingleModel: (b, m) => {
      const candidate = candidates.find((item) => `${item.providerId}/${item.upstreamModelId}` === m);
      return handleSingleModelChat(b, m, clientRawRequest, request, apiKey, {
        attemptBudget: routeBudget,
        signal: routeBudget.signal,
        maxAccountAttempts: maxAccountAttemptsPerProvider,
        standardRoute: true,
        standardModelId: standardModel.id,
        responseAffinity: affinityCandidate ? { previousResponseId } : null,
        preferredConnectionId: responseAffinity?.connectionId || null,
        // Feed the standard model identity + declared capabilities into the
        // shared resolver so the runtime applies the same bundled-catalog and
        // local-DB layers as /v1/models.
        standardModelPublicName: candidate?.publicName || standardModel.publicName || null,
        standardModelCapabilities: candidate?.standardModelCapabilities || null,
        capabilityOverrides: candidate?.capabilityOverrides || null,
        onResponseId: (responseId, metadata = {}) => recordStandardResponseAffinity(responseId, {
          standardModelId: standardModel.id,
          providerId: candidate?.providerId,
          upstreamModelId: candidate?.upstreamModelId,
          connectionId: metadata.connectionId,
        }),
      }, capabilityResolver);
    },
    log,
    comboName: `standard:${modelStr}`,
    comboStrategy: "fallback",
    autoSwitch: false,
    capabilityResolver,
    attemptBudget: routeBudget,
    abortSignal: request?.signal,
    // A standard route already has another provider candidate; do not spend
    // the legacy combo transient sleep before probing it.
    failureClassifier: ({ status, errorText }) => {
      const classification = classifyStandardRouteFailure({ status, error: errorText });
      return {
        ...classification,
        shouldFallback: affinityCandidate ? false : classification.shouldFallback,
        retryable: affinityCandidate ? false : classification.retryable,
        cooldownMs: 0,
      };
    },
    onAttemptResult: (attempt) => {
      if (attempt.ok) {
        const candidate = candidates.find((item) => `${item.providerId}/${item.upstreamModelId}` === attempt.model);
        if (candidate) recordStandardProviderSuccess(getStandardProviderHealthKey(standardModel.id, candidate.providerId, candidate.upstreamModelId));
        return;
      }
      const candidate = candidates.find((item) => `${item.providerId}/${item.upstreamModelId}` === attempt.model);
      if (!candidate || attempt.shouldFallback === false || attempt.healthEligible === false) return;
      const classification = classifyStandardRouteFailure({ status: attempt.status, error: attempt.errorText });
      if (classification.healthEligible) {
        recordStandardProviderFailure(
          getStandardProviderHealthKey(standardModel.id, candidate.providerId, candidate.upstreamModelId),
          { category: classification.category, status: attempt.status },
        );
      }
      failures.push({ ...attempt, category: classification.category, retryable: classification.retryable });
    },
    onAllFailed: ({ status, message, budgetExhausted, budget }) => buildStandardRouteErrorResponse({
      status,
      message: budgetExhausted ? `Standard model route attempt budget exhausted: ${modelStr}` : message,
      publicModel: modelStr,
      code: budgetExhausted ? "attempt_budget_exhausted" : (affinityCandidate ? "response_affinity_failed" : "provider_unavailable"),
      retryable: affinityCandidate ? false : true,
      failures: failures.length > 0 ? failures : [],
      budget,
    }),
    });
  } catch (error) {
    routeBudget.dispose?.();
    throw error;
  }
  // A forced JSON response may have committed its 200 heartbeat while the
  // provider is still buffering. Keep the shared deadline alive until that
  // deferred outcome settles; ordinary response bodies own cleanup until EOF.
  const deferredOutcome = routedResponse?.__9routerDeferredOutcome;
  if (deferredOutcome) {
    Promise.resolve(deferredOutcome).finally(() => routeBudget.dispose?.()).catch(() => {});
  }
  return withStandardRouteBudgetResponse(routedResponse, routeBudget);
}

/**
 * Handle single model chat request
 */
export async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, routeContext = null, capabilityResolver = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings, capabilityResolver);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null, capabilityResolver);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, capabilityResolver),
          adapterAdded,
          capabilityResolver
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        capabilityResolver
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;
  // Standard-model routes carry their public identity + declared capabilities
  // in routeContext; both entry points share the same aggregation so the
  // advertised capabilities match what the runtime strips/forwards.
  const capabilityContext = {
    publicName: routeContext?.standardModelPublicName || null,
    persisted: routeContext?.standardModelCapabilities || null,
    overrides: routeContext?.capabilityOverrides || null,
  };
  const modelCapabilities = capabilityResolver
    ? capabilityResolver(provider, model, capabilityContext)
    : resolveCapabilities({ provider, model, ...capabilityContext });

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let accountAttempts = 0;
  let commandCodeTransientRetries = 0;
  let commandCodeRetryConnectionId = null;

  while (true) {
    if (routeContext?.attemptBudget && !routeContext.attemptBudget.canAttempt()) {
      if (request?.signal?.aborted) return errorResponse(499, "Request aborted");
      return buildStandardRouteErrorResponse({
        status: HTTP_STATUS.SERVICE_UNAVAILABLE,
        message: "Standard route attempt budget exhausted",
        publicModel: routeContext.standardModelPublicName,
        code: "attempt_budget_exhausted",
        budget: routeContext.attemptBudget,
      });
    }
    if (routeContext?.signal?.aborted || request?.signal?.aborted) {
      return errorResponse(499, "Request aborted");
    }
    const retryConnectionId = commandCodeRetryConnectionId;
    commandCodeRetryConnectionId = null;
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      preferredConnectionId: retryConnectionId || routeContext?.preferredConnectionId || null,
    });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    if (routeContext?.preferredConnectionId
      && (credentials.connectionId || credentials.id) !== routeContext.preferredConnectionId) {
      return errorResponse(409, `Response affinity account is unavailable for provider: ${provider}`);
    }

    const maxAccountAttempts = Number(routeContext?.maxAccountAttempts);
    if (Number.isFinite(maxAccountAttempts) && maxAccountAttempts > 0 && accountAttempts >= Math.floor(maxAccountAttempts)) {
      return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, `Account attempt budget exhausted for provider: ${provider}`);
    }
    accountAttempts += 1;

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const effectiveRouteContext = routeContext
      ? {
        ...routeContext,
        onResponseId: typeof routeContext.onResponseId === "function"
          ? (responseId) => routeContext.onResponseId(responseId, { connectionId: credentials.connectionId || credentials.id })
          : routeContext.onResponseId,
      }
      : null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      modelCapabilities,
      credentials: refreshedCredentials,
      log,
      requestSignal: request?.signal,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      routeContext: effectiveRouteContext,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    if (result.success) {
      if (result.deferredOutcome && result.response) {
        // A forced JSON response may have committed a 200 heartbeat before its
        // upstream outcome is known.  Carry that outcome alongside the Response
        // so combo/standard routing can defer health telemetry without treating
        // the provisional response as a provider success.
        try {
          Object.defineProperty(result.response, "__9routerDeferredOutcome", {
            value: result.deferredOutcome,
            configurable: true,
          });
        } catch { /* Response implementations may be sealed */ }
      }
      return result.response;
    }

    // A route budget is a request-level control signal, never a provider
    // health failure. Do not pass its synthetic 503 through account cooldown
    // or fallback bookkeeping.
    const budgetFailure = routeContext?.attemptBudget && (
      routeContext.attemptBudget.snapshot?.().timedOut
      || /standard route .*budget|attempt budget exhausted/i.test(String(result.error || ""))
    );
    if (budgetFailure) return result.response;

    // CommandCode may answer with HTTP 200 and then emit a body-level 520/503
    // gateway error before any model output. Retry that request once on the
    // same provider path before persisting a 30s model lock. The preflight
    // stream check guarantees that no client-visible output was committed.
    const accountAttemptLimit = Number(routeContext?.maxAccountAttempts);
    const canRetryCommandCode = !Number.isFinite(accountAttemptLimit)
      || accountAttemptLimit <= 0
      || accountAttempts < Math.floor(accountAttemptLimit);
    if (provider === "commandcode"
      && commandCodeTransientRetries < 1
      && canRetryCommandCode
      && isTransientCommandCodeError(result.status, result.error)) {
      commandCodeTransientRetries += 1;
      commandCodeRetryConnectionId = credentials.connectionId || credentials.id || null;
      log.warn("RETRY", `[${provider}/${model}] transient gateway error; retrying once before account lock`);
      await waitForCommandCodeRetry(routeContext?.signal || request?.signal);
      continue;
    }

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
