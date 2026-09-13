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
import { planStandardModelCandidates } from "@/lib/standardModels/planner";
import {
  STANDARD_ROUTE_DEFAULTS,
  classifyStandardRouteFailure,
  buildStandardRouteErrorResponse,
  createStandardRouteBudget,
  getStandardProviderHealthKey,
  getStandardProviderHealth,
  recordStandardProviderFailure,
  recordStandardProviderSuccess,
} from "@/lib/standardModels/runtime";
import * as log from "../utils/logger.js";

// Providers that don't require credentials (noAuth)
const NO_AUTH_PROVIDERS = new Set(["sdwebui", "comfyui"]);
const IMAGE_REQUEST_FORMATS = ["openai-images", "openai-image", "openai"];
const IMAGE_GENERATION_OPERATIONS = ["image_generation", "images.generate", "generation", "generate", "text_to_image"];
const IMAGE_EDIT_OPERATIONS = ["image_edit", "images.edit", "edit", "image_to_image", "inpainting"];

/**
 * Keep a standard-route deadline alive until a streamed image response is
 * consumed. Most image providers return a buffered JSON response, while
 * Codex can return an SSE body that continues after routing has selected it.
 */
function withImageRouteBudgetResponse(response, budget) {
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
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function standardRouteBudgetFailure(routeContext) {
  if (!routeContext?.attemptBudget) return null;
  if (routeContext.requestSignal?.aborted) {
    return errorResponse(499, "Request aborted");
  }
  if (!routeContext.attemptBudget.canAttempt?.()) {
    return buildStandardRouteErrorResponse({
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      message: "Standard route attempt budget exhausted",
      publicModel: routeContext.standardModelPublicName,
      code: "attempt_budget_exhausted",
      budget: routeContext.attemptBudget,
    });
  }
  return null;
}

function isFileLike(value) {
  return value && typeof value === "object" && typeof value.arrayBuffer === "function";
}

function inferMimeType(name = "") {
  const extension = String(name).toLowerCase().split(".").pop();
  return ({
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    avif: "image/avif",
  })[extension] || "image/png";
}

async function imageValueToDataUrl(value) {
  if (isFileLike(value)) {
    const bytes = Buffer.from(await value.arrayBuffer());
    const mime = value.type || inferMimeType(value.name);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }
  if (typeof value === "string") return value.trim() || null;
  return null;
}

function formEntries(form, name) {
  if (typeof form?.getAll === "function") {
    return form.getAll(name).filter((value) => value !== null && value !== undefined);
  }
  const value = form?.get?.(name);
  return value === null || value === undefined ? [] : [value];
}

function parseScalar(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

async function parseMultipartImageRequest(request) {
  const form = await request.formData();
  const body = {};
  const scalarFields = [
    "model", "prompt", "n", "size", "quality", "background", "input_fidelity",
    "output_format", "output_compression", "response_format", "style", "image_detail",
    "negative_prompt", "guidance", "seed", "steps", "num_steps", "strength", "width", "height",
  ];
  for (const field of scalarFields) {
    const value = form.get(field);
    if (value !== null && value !== undefined && !isFileLike(value)) body[field] = parseScalar(value);
  }

  const images = [];
  for (const field of ["image", "images"]) {
    for (const value of formEntries(form, field)) {
      const dataUrl = await imageValueToDataUrl(value);
      if (dataUrl) images.push(dataUrl);
    }
  }
  if (images.length === 1) body.image = images[0];
  if (images.length > 1) body.images = images;

  for (const field of ["mask", "mask_image", "maskImage"]) {
    const value = form.get(field);
    if (value !== null && value !== undefined) {
      const dataUrl = await imageValueToDataUrl(value);
      if (dataUrl) {
        body.mask = dataUrl;
        body.mask_image = dataUrl;
        break;
      }
    }
  }
  return body;
}

async function parseImageRequest(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.toLowerCase().includes("multipart/form-data")) {
    return parseMultipartImageRequest(request);
  }
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function imageInputs(body = {}) {
  const values = [];
  if (Array.isArray(body.images)) values.push(...body.images);
  if (body.image !== undefined && body.image !== null) {
    if (Array.isArray(body.image)) values.push(...body.image);
    else values.push(body.image);
  }
  return values.filter((value) => typeof value === "string" && value.trim());
}

/** Handle POST /v1/images/generations. */
export async function handleImageGeneration(request) {
  return handleImageRequest(request, { operation: "generate" });
}

/** Handle POST /v1/images/edits (JSON and multipart/form-data). */
export async function handleImageEdit(request) {
  return handleImageRequest(request, { operation: "edit", requireImage: true });
}

async function handleImageRequest(request, { operation = "generate", requireImage = false } = {}) {
  let body;
  try {
    body = await parseImageRequest(request);
  } catch (error) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, error?.message || "Invalid JSON body");
  }

  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream");
  const binaryOutput = url.searchParams.get("response_format") === "binary" || body.response_format === "binary";
  const modelStr = body.model;

  // This is consumed by provider adapters and never forwarded as an upstream
  // API parameter. It lets native OpenAI-compatible providers select /edits.
  body.image_operation = operation;

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  if (requireImage && imageInputs(body).length === 0) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "At least one input image is required");
  }

  // Registered bare names are resolved before legacy aliases and combos, just
  // like chat requests. All provider/account work stays in the existing path.
  const standardRouting = settings.standardModelRouting || {};
  if (standardRouting.enabled === true && !String(modelStr).includes("/")) {
    const standardModel = await getStandardModelByName(modelStr);
    if (standardModel) {
      return handleStandardModelImage({
        body,
        modelStr,
        standardModel,
        operation,
        request,
        binaryOutput,
        wantsStream,
        preferredConnectionId,
      });
    }
  }

  // Combo expansion: model may be a combo name → fallback/round-robin across models.
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("IMAGE", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelImage(b, m, {
        wantsStream,
        binaryOutput,
        preferredConnectionId,
        requestSignal: request.signal,
      }),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      abortSignal: request.signal,
    });
  }

  return handleSingleModelImage(body, modelStr, {
    wantsStream,
    binaryOutput,
    preferredConnectionId,
    requestSignal: request.signal,
  });
}

/** Resolve a registered bare image model to provider/upstream candidates. */
async function handleStandardModelImage({
  body,
  modelStr,
  standardModel,
  operation,
  request,
  binaryOutput,
  wantsStream,
  preferredConnectionId = null,
}) {
  if (request?.signal?.aborted) return errorResponse(499, "Request aborted");

  const settings = await getSettings();
  const policy = {
    ...(settings.standardModelRouting?.defaultPolicy || {}),
    ...(standardModel.policy || {}),
  };
  delete policy.selection;

  const bindings = await getStandardModelBindings(standardModel.id);
  const operations = operation === "edit" ? IMAGE_EDIT_OPERATIONS : IMAGE_GENERATION_OPERATIONS;
  const modelForPlanning = { ...standardModel, requiredCapabilities: {} };
  let plan = planStandardModelCandidates({
    model: modelForPlanning,
    bindings,
    requestFormat: IMAGE_REQUEST_FORMATS,
    operation: operations,
    requireConfiguredProvider: true,
  });
  // Older mappings often scoped the operation but left requestFormats empty.
  // Retry without the format filter while retaining operation matching.
  if (plan.candidates.length === 0) {
    plan = planStandardModelCandidates({
      model: modelForPlanning,
      bindings,
      requestFormat: null,
      operation: operations,
      requireConfiguredProvider: true,
    });
  }
  if (plan.candidates.length === 0) {
    return buildStandardRouteErrorResponse({
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      message: `No available provider for standard model: ${modelStr}`,
      publicModel: modelStr,
      code: "no_provider_mapping",
      retryable: false,
      failures: plan.excluded.map((item) => ({ provider: item.providerId, category: item.reason, retryable: false })),
    });
  }

  // Keep provider health scoped to the standard model + mapping. An image
  // provider that is cooling down for chat should still be eligible here.
  const healthyCandidates = plan.candidates.filter((candidate) => {
    const key = getStandardProviderHealthKey(standardModel.id, candidate.providerId, candidate.upstreamModelId);
    return !getStandardProviderHealth(key);
  });
  const routableCandidates = healthyCandidates.length > 0 ? healthyCandidates : plan.candidates;
  const maxProviderAttempts = Number(policy.maxProviderAttempts);
  const candidates = policy.fallbackStrategy === "none"
    ? routableCandidates.slice(0, 1)
    : Number.isFinite(maxProviderAttempts) && maxProviderAttempts > 0
      ? routableCandidates.slice(0, Math.floor(maxProviderAttempts))
      : routableCandidates;
  const models = candidates.map((candidate) => `${candidate.providerId}/${candidate.upstreamModelId}`);
  const maxGenerationAttempts = Number(policy.maxGenerationAttempts);
  const routeBudget = createStandardRouteBudget({
    maxAttempts: Number.isFinite(maxGenerationAttempts) && maxGenerationAttempts > 0
      ? maxGenerationAttempts
      : STANDARD_ROUTE_DEFAULTS.maxGenerationAttempts,
    timeoutMs: Number(policy.maxRouteDurationMs || policy.timeoutMs) || STANDARD_ROUTE_DEFAULTS.maxRouteDurationMs,
    signal: request?.signal,
  });
  const maxAccountAttempts = Number(policy.maxAccountAttemptsPerProvider);
  const failures = [];

  try {
    const routedResponse = await handleComboChat({
      body,
      models,
      handleSingleModel: (candidateBody, model) => handleSingleModelImage(candidateBody, model, {
        wantsStream,
        binaryOutput,
        preferredConnectionId,
        requestSignal: request?.signal,
        routeContext: {
          attemptBudget: routeBudget,
          signal: routeBudget.signal,
          requestSignal: request?.signal,
          standardModelPublicName: modelStr,
          maxAccountAttempts,
        },
      }),
      log,
      comboName: `standard:image:${modelStr}:${operation}`,
      comboStrategy: "fallback",
      autoSwitch: false,
      attemptBudget: routeBudget,
      abortSignal: request?.signal,
      failureClassifier: ({ status, errorText }) => {
        const classification = classifyStandardRouteFailure({ status, error: errorText });
        return {
          ...classification,
          shouldFallback: policy.fallbackStrategy === "none" ? false : classification.shouldFallback,
          retryable: policy.fallbackStrategy === "none" ? false : classification.retryable,
          cooldownMs: 0,
        };
      },
      onAttemptResult: (attempt) => {
        const candidate = candidates.find((item) => `${item.providerId}/${item.upstreamModelId}` === attempt.model);
        if (!candidate) return;
        const key = getStandardProviderHealthKey(standardModel.id, candidate.providerId, candidate.upstreamModelId);
        if (attempt.ok) {
          recordStandardProviderSuccess(key);
          return;
        }
        const classification = classifyStandardRouteFailure({ status: attempt.status, error: attempt.errorText });
        if (attempt.shouldFallback !== false && classification.healthEligible) {
          recordStandardProviderFailure(key, {
            category: classification.category,
            status: attempt.status,
          });
        }
        failures.push({ ...attempt, category: classification.category, retryable: classification.retryable });
      },
      onAllFailed: ({ status, message, budgetExhausted, budget }) => buildStandardRouteErrorResponse({
        status,
        message: budgetExhausted
          ? `Standard model route attempt budget exhausted: ${modelStr}`
          : (message || `No available provider for standard model: ${modelStr}`),
        publicModel: modelStr,
        code: budgetExhausted ? "attempt_budget_exhausted" : "provider_unavailable",
        retryable: !budgetExhausted,
        failures,
        budget,
      }),
    });
    return withImageRouteBudgetResponse(routedResponse, routeBudget);
  } catch (error) {
    routeBudget.dispose?.();
    throw error;
  }
}

async function handleSingleModelImage(body, modelStr, {
  wantsStream,
  binaryOutput,
  preferredConnectionId,
  requestSignal = null,
  routeContext = null,
} = {}) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;

  // noAuth providers — no credential needed
  if (NO_AUTH_PROVIDERS.has(provider)) {
    if (requestSignal?.aborted) return errorResponse(499, "Request aborted");
    const budgetFailure = standardRouteBudgetFailure(routeContext);
    if (budgetFailure) return budgetFailure;
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: null,
      binaryOutput,
      signal: requestSignal,
      attemptBudget: routeContext?.attemptBudget || null,
    });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Image generation failed");
  }

  // Credentialed providers — preserve the existing account fallback, refresh,
  // and success/error bookkeeping for both generations and edits.
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let accountAttempts = 0;

  while (true) {
    const budgetFailure = standardRouteBudgetFailure(routeContext);
    if (budgetFailure) return budgetFailure;
    if (requestSignal?.aborted || routeContext?.requestSignal?.aborted) {
      return errorResponse(499, "Request aborted");
    }
    const maxAccountAttempts = Number(routeContext?.maxAccountAttempts);
    if (Number.isFinite(maxAccountAttempts) && maxAccountAttempts > 0 && accountAttempts >= Math.floor(maxAccountAttempts)) {
      return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, `Account attempt budget exhausted for provider: ${provider}`);
    }

    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        return errorResponse(
          routeContext ? HTTP_STATUS.NOT_FOUND : HTTP_STATUS.BAD_REQUEST,
          routeContext ? `No active credentials for provider: ${provider}` : `No credentials for provider: ${provider}`,
        );
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    accountAttempts += 1;
    let refreshedCredentials;
    try {
      refreshedCredentials = await checkAndRefreshToken(provider, credentials, {
        signal: routeContext?.signal || requestSignal || null,
        attemptBudget: routeContext?.attemptBudget || null,
        model,
      });
    } catch (error) {
      if (requestSignal?.aborted || routeContext?.requestSignal?.aborted) return errorResponse(499, "Request aborted");
      if (routeContext?.attemptBudget?.isBudgetError?.(error) || routeContext?.attemptBudget?.snapshot?.()?.timedOut) {
        return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "Standard route attempt budget exhausted");
      }
      throw error;
    }
    if (requestSignal?.aborted || routeContext?.requestSignal?.aborted) {
      return errorResponse(499, "Request aborted");
    }

    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      streamToClient: wantsStream,
      binaryOutput,
      signal: requestSignal,
      attemptBudget: routeContext?.attemptBudget || null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active",
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
    });

    if (result.success) return result.response;

    if (requestSignal?.aborted || routeContext?.requestSignal?.aborted || result.status === 499) {
      return errorResponse(499, "Request aborted");
    }

    const budgetFailureAfterAttempt = routeContext?.attemptBudget && (
      routeContext.attemptBudget.isBudgetError?.(result.error)
      || routeContext.attemptBudget.snapshot?.()?.timedOut
      || /standard route .*budget|attempt budget exhausted/i.test(String(result.error || ""))
    );
    if (budgetFailureAfterAttempt) return result.response;

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

export const __test__ = {
  imageInputs,
  parseScalar,
  parseMultipartImageRequest,
};
