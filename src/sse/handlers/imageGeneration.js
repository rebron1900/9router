import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings, getStandardModelByName, getStandardModelBindings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat } from "open-sse/services/combo.js";
import { parseImageRequest } from "./imageRequest.js";
import { planStandardModelCandidates } from "@/lib/standardModels/planner";
import {
  buildStandardRouteErrorResponse,
  classifyStandardRouteFailure,
} from "@/lib/standardModels/runtime";
import * as log from "../utils/logger.js";

// Providers that don't require credentials (noAuth)
const NO_AUTH_PROVIDERS = new Set(["sdwebui", "comfyui"]);

/**
 * Handle an OpenAI-compatible image generation or edit request.
 *
 * The route parser accepts JSON and multipart/form-data. Both paths are
 * normalized before the existing provider/account fallback loop is entered.
 * @param {Request} request
 * @param {object} [options]
 * @param {"generation"|"edit"} [options.operation]
 * @param {boolean} [options.requireInputImage]
 */
export async function handleImageGeneration(request, { operation = "generation", requireInputImage = false } = {}) {
  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream");
  const binaryOutput = url.searchParams.get("response_format") === "binary";

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  let body;
  try {
    body = await parseImageRequest(request, { requireInputImage });
  } catch (error) {
    return errorResponse(error.status || HTTP_STATUS.BAD_REQUEST, error.message || "Invalid image request");
  }

  const modelStr = typeof body.model === "string" ? body.model.trim() : "";
  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  }
  body.model = modelStr;
  body._imageOperation = operation === "edit" ? "edit" : "generation";

  // Standard model names are provider-neutral public identities. Explicit
  // provider/model names, legacy aliases, and combos keep their old paths.
  const standardRouting = settings.standardModelRouting || {};
  if (standardRouting.enabled === true && !modelStr.includes("/")) {
    const standardModel = await getStandardModelByName(modelStr);
    if (standardModel) {
      return handleStandardModelImage({
        body,
        modelStr,
        standardModel,
        operation: body._imageOperation,
        wantsStream,
        binaryOutput,
        preferredConnectionId,
        settings,
      });
    }
  }

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("IMAGE", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelImage(b, m, { wantsStream, binaryOutput, preferredConnectionId }),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId });
}

function classifyImageStandardFailure({ status, errorText }) {
  const text = String(errorText || "");
  // The generic classifier treats every 400 as a caller error. These messages
  // are provider capability/configuration failures, so the next mapped image
  // provider should be tried instead.
  if (/does not support image generation|invalid model format|no credentials for provider|model not found|unsupported model|does not support model|unknown model|model .* does not exist/i.test(text)) {
    return {
      category: /no credentials/i.test(text) ? "auth" : "unsupported_model",
      retryable: true,
      shouldFallback: true,
      healthEligible: true,
      cooldownMs: 0,
    };
  }
  return {
    ...classifyStandardRouteFailure({ status, error: text }),
    cooldownMs: 0,
  };
}

async function handleStandardModelImage({
  body,
  modelStr,
  standardModel,
  operation,
  wantsStream,
  binaryOutput,
  preferredConnectionId,
  settings,
}) {
  let bindings;
  try {
    bindings = await getStandardModelBindings(standardModel.id);
  } catch (error) {
    log.warn("IMAGE", `Failed to load standard model mappings for ${modelStr}`, { error: error?.message });
    return buildStandardRouteErrorResponse({
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      message: `Unable to load provider mappings for standard model: ${modelStr}`,
      publicModel: modelStr,
      code: "standard_model_mapping_error",
    });
  }

  const modelForPlanning = {
    ...standardModel,
    requiredCapabilities: {
      ...(standardModel.requiredCapabilities || {}),
      imageOutput: true,
    },
  };
  const plan = planStandardModelCandidates({
    model: modelForPlanning,
    bindings,
    requestFormat: "openai-images",
    operation,
    requireConfiguredProvider: true,
  });

  if (plan.candidates.length === 0) {
    const reason = plan.excluded[0]?.reason || "no_provider_mapping";
    log.warn("IMAGE", `Standard model "${modelStr}" has no image provider (${reason})`);
    return buildStandardRouteErrorResponse({
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      message: `No available image provider for standard model: ${modelStr}`,
      publicModel: modelStr,
      code: "no_image_provider_mapping",
      retryable: false,
      failures: plan.excluded.map((item) => ({
        provider: item.providerId,
        category: item.reason,
        retryable: false,
      })),
    });
  }

  const policy = {
    ...(settings.standardModelRouting?.defaultPolicy || {}),
    ...(standardModel.policy || {}),
  };
  const maxProviderAttempts = Number(policy.maxProviderAttempts);
  const candidates = policy.fallbackStrategy === "none"
    ? plan.candidates.slice(0, 1)
    : Number.isFinite(maxProviderAttempts) && maxProviderAttempts > 0
      ? plan.candidates.slice(0, Math.floor(maxProviderAttempts))
      : plan.candidates;
  const providerModels = candidates.map((candidate) => `${candidate.providerId}/${candidate.upstreamModelId}`);
  const failures = [];

  log.info("IMAGE", `Standard model "${modelStr}" (${operation}) → ${providerModels.join(", ")}`);
  return handleComboChat({
    body,
    models: providerModels,
    handleSingleModel: (requestBody, providerModel) => handleSingleModelImage(
      requestBody,
      providerModel,
      { wantsStream, binaryOutput, preferredConnectionId },
    ),
    log,
    comboName: `standard:image:${modelStr}:${operation}`,
    comboStrategy: "fallback",
    autoSwitch: false,
    failureClassifier: classifyImageStandardFailure,
    onAttemptResult: (attempt) => {
      if (!attempt.ok) failures.push(attempt);
    },
    onAllFailed: ({ status, message, budgetExhausted, budget }) => buildStandardRouteErrorResponse({
      status: status >= 500 || status === HTTP_STATUS.RATE_LIMITED ? status : HTTP_STATUS.SERVICE_UNAVAILABLE,
      message: budgetExhausted ? `Standard image route attempt budget exhausted: ${modelStr}` : message,
      publicModel: modelStr,
      code: budgetExhausted ? "attempt_budget_exhausted" : "image_provider_unavailable",
      retryable: true,
      failures,
      budget,
    }),
  });
}

async function handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId } = {}) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;

  // noAuth providers — no credential needed
  if (NO_AUTH_PROVIDERS.has(provider)) {
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: null,
      binaryOutput,
    });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Image generation failed");
  }

  // Credentialed providers — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      streamToClient: wantsStream,
      binaryOutput,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (result.success) return result.response;

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);

    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
