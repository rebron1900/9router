import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { getExecutor } from "../executors/index.js";
import { getImageAdapter } from "./imageProviders/index.js";
import { urlToBase64 } from "./imageProviders/_base.js";

function serializeRequestBody(requestBody) {
  if (typeof FormData !== "undefined" && requestBody instanceof FormData) return requestBody;
  if (typeof requestBody === "string") return requestBody;
  return JSON.stringify(requestBody);
}

function mergeSignals(...signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) return null;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") return AbortSignal.any(active);

  // AbortSignal.any is available in the supported Node runtimes, but keep a
  // small fallback for Workers/test doubles that only implement the basic
  // AbortSignal API.
  const controller = new AbortController();
  const abort = (signal) => () => controller.abort(signal.reason);
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener?.("abort", abort(signal), { once: true });
  }
  return controller.signal;
}

function isBudgetError(error, attemptBudget) {
  return attemptBudget?.isBudgetError?.(error)
    || attemptBudget?.snapshot?.()?.timedOut
    || error?.code === "STANDARD_ROUTE_BUDGET_EXHAUSTED";
}

function isRequestAborted(error, requestSignal) {
  return requestSignal?.aborted === true
    || (error?.name === "AbortError" && requestSignal?.aborted === true);
}

function consumeFetchAttempt(attemptBudget, metadata) {
  if (!attemptBudget) return;
  const consumed = attemptBudget.consume?.(metadata);
  if (consumed && !consumed.allowed) throw attemptBudget.error();
}

/**
 * Core image generation handler — orchestrator only.
 * Provider-specific URL/headers/body/parse/normalize live in `./imageProviders/{id}.js`.
 *
 * @param {object} options
 * @param {object} options.body - Request body { model, prompt, n, size, ... }
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {object} [options.log] - Logger
 * @param {boolean} [options.streamToClient] - Pipe SSE to client (codex)
 * @param {boolean} [options.binaryOutput] - Return raw image bytes
 * @param {AbortSignal} [options.signal] - Client/request cancellation signal
 * @param {object} [options.attemptBudget] - Request-scoped standard-route budget
 * @param {function} [options.onCredentialsRefreshed]
 * @param {function} [options.onRequestSuccess]
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string }>}
 */
export async function handleImageGenerationCore({
  body,
  modelInfo,
  credentials,
  log,
  streamToClient = false,
  binaryOutput = false,
  signal = null,
  attemptBudget = null,
  onCredentialsRefreshed,
  onRequestSuccess,
}) {
  const { provider, model } = modelInfo;
  const executionSignal = mergeSignals(signal, attemptBudget?.signal);

  if (!body.prompt) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  }

  const adapter = getImageAdapter(provider);
  if (!adapter) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support image generation`
    );
  }

  // Executor-delegating adapters: skip manual URL/headers/body, use the proven executor flow
  if (adapter.useExecutor && adapter.executeViaExecutor) {
    try {
      log?.debug?.("IMAGE", `${provider.toUpperCase()} | ${model} | prompt="${body.prompt.slice(0, 50)}..." (executor)`);
      const responseBody = await adapter.executeViaExecutor(model, body, credentials, log, {
        signal: executionSignal,
        attemptBudget,
      });
      if (onRequestSuccess) await onRequestSuccess();
      const normalized = adapter.normalize(responseBody, body.prompt);
      const finalBody = (normalized.created && Array.isArray(normalized.data)) ? normalized : responseBody;

      if (binaryOutput) {
        const first = finalBody.data?.[0];
        let b64 = first?.b64_json;
        if (!b64 && first?.url) {
          try {
            b64 = await urlToBase64(first.url, { signal: executionSignal });
          } catch (error) {
            if (isRequestAborted(error, signal)) return createErrorResult(499, "Request aborted");
            if (isBudgetError(error, attemptBudget)) {
              return createErrorResult(HTTP_STATUS.SERVICE_UNAVAILABLE, "Standard route attempt budget exhausted");
            }
          }
        }
        if (b64) {
          const buf = Buffer.from(b64, "base64");
          const fmt = (body.output_format || "png").toLowerCase();
          const mime = fmt === "jpeg" || fmt === "jpg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png";
          return {
            success: true,
            response: new Response(buf, {
              headers: { "Content-Type": mime, "Content-Disposition": `inline; filename="image.${fmt === "jpeg" ? "jpg" : fmt}"`, "Access-Control-Allow-Origin": "*" },
            }),
          };
        }
      }

      return {
        success: true,
        response: new Response(JSON.stringify(finalBody), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        }),
      };
    } catch (error) {
      if (isRequestAborted(error, signal)) {
        return createErrorResult(499, "Request aborted");
      }
      if (isBudgetError(error, attemptBudget)) {
        return createErrorResult(HTTP_STATUS.SERVICE_UNAVAILABLE, "Standard route attempt budget exhausted");
      }
      const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
      log?.debug?.("IMAGE", `Executor error: ${errMsg}`);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
    }
  }

  let url;
  let headers;
  let requestBody;

  try {
    url = adapter.buildUrl(model, credentials, body);
    requestBody = await adapter.buildBody(model, body, { signal: executionSignal, attemptBudget });
    headers = adapter.buildHeaders(credentials, requestBody, model, body);
  } catch (error) {
    if (isRequestAborted(error, signal)) {
      return createErrorResult(499, "Request aborted");
    }
    if (isBudgetError(error, attemptBudget)) {
      return createErrorResult(HTTP_STATUS.SERVICE_UNAVAILABLE, "Standard route attempt budget exhausted");
    }
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, error.message || `Invalid ${provider} image request`);
  }

  log?.debug?.("IMAGE", `${provider.toUpperCase()} | ${model} | prompt="${body.prompt.slice(0, 50)}..."`);

  let providerResponse;
  try {
    consumeFetchAttempt(attemptBudget, { provider, model, scope: "fetch", url });
    const fetchOptions = {
      method: "POST",
      headers,
      body: serializeRequestBody(requestBody),
    };
    if (executionSignal) fetchOptions.signal = executionSignal;
    providerResponse = await fetch(url, fetchOptions);
  } catch (error) {
    if (isRequestAborted(error, signal)) {
      return createErrorResult(499, "Request aborted");
    }
    if (isBudgetError(error, attemptBudget)) {
      return createErrorResult(HTTP_STATUS.SERVICE_UNAVAILABLE, "Standard route attempt budget exhausted");
    }
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("IMAGE", `Fetch error: ${errMsg}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  // Handle 401/403 — try token refresh (skipped for noAuth providers)
  const executor = getExecutor(provider);
  if (
    !executor?.noAuth &&
    !adapter.noAuth &&
    (providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
      providerResponse.status === HTTP_STATUS.FORBIDDEN)
  ) {
    const newCredentials = await refreshWithRetry(
      () => executor.refreshCredentials(credentials, log, {
        signal: executionSignal,
        attemptBudget,
        model,
      }),
      3,
      log,
      executionSignal
    );

    if (newCredentials?.accessToken || newCredentials?.apiKey) {
      log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for image generation`);
      Object.assign(credentials, newCredentials);
      if (onCredentialsRefreshed) await onCredentialsRefreshed(newCredentials);

      try {
        const retryBody = await adapter.buildBody(model, body, { signal: executionSignal, attemptBudget });
        const retryHeaders = adapter.buildHeaders(credentials, retryBody, model, body);
        const retryUrl = adapter.buildUrl(model, credentials, body);
        consumeFetchAttempt(attemptBudget, { provider, model, scope: "fetch", url: retryUrl, retry: true });
        const retryOptions = {
          method: "POST",
          headers: retryHeaders,
          body: serializeRequestBody(retryBody),
        };
        if (executionSignal) retryOptions.signal = executionSignal;
        providerResponse = await fetch(retryUrl, retryOptions);
      } catch (error) {
        if (isRequestAborted(error, signal)) return createErrorResult(499, "Request aborted");
        if (isBudgetError(error, attemptBudget)) {
          return createErrorResult(HTTP_STATUS.SERVICE_UNAVAILABLE, "Standard route attempt budget exhausted");
        }
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`);
      }
    } else {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
    }
  }

  if (!providerResponse.ok) {
    const { statusCode, message } = await parseUpstreamError(providerResponse);
    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    log?.debug?.("IMAGE", `Provider error: ${errMsg}`);
    return createErrorResult(statusCode, errMsg);
  }

  // Parse provider response — adapter may override (codex SSE / async polling / binary)
  let parsed;
  try {
    if (adapter.parseResponse) {
      parsed = await adapter.parseResponse(providerResponse, {
        headers,
        log,
        streamToClient,
        signal: executionSignal,
        attemptBudget,
        onRequestSuccess,
        url,
        requestBody,
        model,
        body,
      });
      // Codex streaming case: returns an SSE Response directly
      if (parsed?.sseResponse) {
        return { success: true, response: parsed.sseResponse };
      }
    } else {
      parsed = await providerResponse.json();
    }
  } catch (parseError) {
    if (isRequestAborted(parseError, signal)) {
      return createErrorResult(499, "Request aborted");
    }
    if (isBudgetError(parseError, attemptBudget)) {
      return createErrorResult(HTTP_STATUS.SERVICE_UNAVAILABLE, "Standard route attempt budget exhausted");
    }
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, parseError.message || `Invalid response from ${provider}`);
  }

  if (onRequestSuccess) await onRequestSuccess();

  // Normalize → OpenAI-compatible shape
  const normalized = adapter.normalize(parsed, body.prompt);

  // Already in OpenAI shape? skip re-normalize
  const finalBody = (normalized.created && Array.isArray(normalized.data)) ? normalized : parsed;

  // Binary output: decode first b64_json (or fetch url) into raw bytes
  if (binaryOutput) {
    const first = finalBody.data?.[0];
    let b64 = first?.b64_json;
    if (!b64 && first?.url) {
      try {
        b64 = await urlToBase64(first.url, { signal: executionSignal });
      } catch (error) {
        if (isRequestAborted(error, signal)) return createErrorResult(499, "Request aborted");
        if (isBudgetError(error, attemptBudget)) {
          return createErrorResult(HTTP_STATUS.SERVICE_UNAVAILABLE, "Standard route attempt budget exhausted");
        }
      }
    }
    if (b64) {
      const buf = Buffer.from(b64, "base64");
      const fmt = (body.output_format || "png").toLowerCase();
      const mime = fmt === "jpeg" || fmt === "jpg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png";
      return {
        success: true,
        response: new Response(buf, {
          headers: {
            "Content-Type": mime,
            "Content-Disposition": `inline; filename="image.${fmt === "jpeg" ? "jpg" : fmt}"`,
            "Access-Control-Allow-Origin": "*",
          },
        }),
      };
    }
  }

  return {
    success: true,
    response: new Response(JSON.stringify(finalBody), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
