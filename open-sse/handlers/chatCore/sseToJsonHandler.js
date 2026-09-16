import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { createErrorResult, isClientDisconnect } from "../../utils/error.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { FORMATS } from "../../translator/formats.js";
import { PROVIDERS } from "../../config/providers.js";
import { toResponsesUsage, readCachedTokens, readCacheWriteTokens } from "../../translator/concerns/usage.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { ROLE, RESPONSES_ITEM } from "../../translator/schema/index.js";

// Responses-API providers (e.g. codex) may emit SSE without content-type + use Responses output shape
const isResponsesProvider = (p) => PROVIDERS[p]?.format === FORMATS.OPENAI_RESPONSES;
import { saveRequestDetail, appendRequestLog } from "@/lib/usageDb.js";

function sanitizeConversionErrorMessage(error, fallback = "Failed to convert streaming response to JSON") {
  const raw = typeof error === "string" ? error : (error?.message || String(error || ""));
  const sanitized = String(raw)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return sanitized ? `${fallback}: ${sanitized}` : fallback;
}

function textFromResponsesMessageItem(item) {
  if (!item?.content || !Array.isArray(item.content)) return "";
  const byType = item.content.find((c) => c.type === "output_text");
  if (typeof byType?.text === "string") return byType.text;
  const anyText = item.content.find((c) => typeof c.text === "string");
  if (typeof anyText?.text === "string") return anyText.text;
  return "";
}

/**
 * Codex / Responses API may emit many alternating reasoning + message items.
 * Early message blocks often have empty output_text; the user-visible answer is usually in the last non-empty message.
 */
function pickAssistantMessageForChatCompletion(output) {
  if (!Array.isArray(output)) return { msgItem: null, textContent: null };
  const messages = output.filter((item) => item?.type === "message");
  if (messages.length === 0) return { msgItem: null, textContent: null };
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textFromResponsesMessageItem(messages[i]);
    if (text.length > 0) return { msgItem: messages[i], textContent: text };
  }
  const last = messages[messages.length - 1];
  return { msgItem: last, textContent: textFromResponsesMessageItem(last) };
}

/**
 * Convert an OpenAI Chat Completions JSON body into the Responses API shape.
 * Inlined here (not imported from nonStreamingHandler.js) to avoid a circular
 * import. Mirrors openAICompletionToResponses in nonStreamingHandler.js.
 */
function extractCustomToolInput(argumentsValue) {
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {});
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* raw freeform input */ }
  return argumentsText;
}

function chatCompletionToResponses(responseBody, customToolNames = null) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];

  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }

  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
    });
  }

  for (const tc of message.tool_calls || []) {
    const fn = tc.function || {};
    const custom = customToolNames?.has(fn.name);
    output.push({
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      id: `${custom ? "ctc" : "fc"}_${tc.id || ""}`,
      call_id: tc.id || "",
      name: fn.name || "",
      ...(custom
        ? { input: extractCustomToolInput(fn.arguments) }
        : { arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}) }),
    });
  }

  const usage = responseBody.usage || {};
  return {
    id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: "response",
    created_at: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    status: "completed",
    background: false,
    error: null,
    output,
    usage: toResponsesUsage(usage),
  };
}

/**
 * Parse OpenAI-style SSE text into a single chat completion JSON.
 * Used when provider forces streaming but client wants non-streaming.
 */
export function parseSSEToOpenAIResponse(rawSSE, fallbackModel) {
  const chunks = [];
  let streamError = null;

  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      if (chunk?.error) streamError = chunk.error;
      else chunks.push(chunk);
    } catch { /* ignore malformed lines */ }
  }

  if (streamError) return { error: streamError };
  if (chunks.length === 0) return null;

  const first = chunks[0];
  const contentParts = [];
  const reasoningParts = [];
  const toolCallMap = new Map(); // index -> { id, type, function: { name, arguments } }
  let finishReason = "stop";
  let usage = null;

  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta || {};
    if (typeof delta.content === "string" && delta.content.length > 0) contentParts.push(delta.content);
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) reasoningParts.push(delta.reasoning_content);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk?.usage && typeof chunk.usage === "object") usage = chunk.usage;

    // Accumulate tool_calls from streaming deltas
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, { id: tc.id || "", type: "function", function: { name: "", arguments: "" } });
        }
        const existing = toolCallMap.get(idx);
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
      }
    }
  }

  const message = { role: "assistant", content: contentParts.join("") || (toolCallMap.size > 0 ? null : "") };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCallMap.size > 0) {
    message.tool_calls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
  }

  const result = {
    id: first.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: first.created || Math.floor(Date.now() / 1000),
    model: first.model || fallbackModel || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }]
  };
  if (usage) result.usage = usage;
  return result;
}

/**
 * Handle case: provider forced streaming but client wants JSON.
 * Supports both Codex/Responses API SSE and standard Chat Completions SSE.
 */
async function handleForcedSSEToJsonBuffered({ providerResponse, sourceFormat, targetFormat, provider, model, requestId, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, customToolNames, trackDone, appendLog, reqTag, log, requestSignal, attemptBudget }) {
  const contentType = providerResponse.headers.get("content-type") || "";
  const isSSE = contentType.includes("text/event-stream") || (contentType === "" && isResponsesProvider(provider));
  if (!isSSE) return null; // not handled here

  trackDone();

  const ctx = {
    requestId, provider, model, connectionId,
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null
  };

  // Codex/Responses API SSE path
  // Branch on the UPSTREAM format (targetFormat = format we spoke to the provider in),
  // not the client format: a Responses-API client behind a chat-native forced-streaming
  // provider still receives chat SSE chunks, which must go through the standard path.
  const isCodexResponsesApi = isResponsesProvider(provider) || targetFormat === FORMATS.OPENAI_RESPONSES;
  if (isCodexResponsesApi) {
    try {
      const jsonResponse = await convertResponsesStreamToJson(providerResponse.body);
      if (onRequestSuccess) await onRequestSuccess();

      const usage = jsonResponse.usage || {};
      appendLog({ tokens: usage, status: "200 OK" });
      saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, requestId, silent: true });
      if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }));

      // Responses `input_tokens` already includes cached and cache-written
      // prompt tokens. Do not add the detail counters again: doing so doubles
      // the denominator used by Agent cache-rate accounting.
      const inTokensForLog = usage.input_tokens ?? usage.prompt_tokens ?? 0;
      const { msgItem, textContent } = pickAssistantMessageForChatCompletion(jsonResponse.output);
      const totalLatency = Date.now() - requestStartTime;

      saveRequestDetail(buildRequestDetail({
        ...ctx,
        latency: { ttft: totalLatency, total: totalLatency },
        tokens: { prompt_tokens: inTokensForLog, completion_tokens: usage.output_tokens || 0 },
        response: { content: textContent, thinking: null, finish_reason: jsonResponse.status || "unknown" },
        status: "success"
      }, { endpoint: clientRawRequest?.endpoint || null })).catch(() => {});

      // Client is Responses API → return as-is
      if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
        return { success: true, response: new Response(JSON.stringify(jsonResponse), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
      }

      // Build client-format response. Responses input_tokens is already
      // cache-inclusive; only expose the read/write counters as details.
      const inTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
      const outTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
      const cacheRead = readCachedTokens(usage);
      const cacheCreate = readCacheWriteTokens(usage);
      const reasoningTokens = usage.output_tokens_details?.reasoning_tokens
        ?? usage.reasoning_tokens
        ?? 0;
      const cacheDetails = (cacheRead > 0 || cacheCreate > 0)
        ? { prompt_tokens_details: {
              ...(cacheRead > 0 ? { cached_tokens: cacheRead } : {}),
              ...(cacheCreate > 0 ? { cache_write_tokens: cacheCreate, cache_creation_tokens: cacheCreate } : {}) } }
        : {};
      const reasoningDetails = reasoningTokens > 0
        ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } }
        : {};
      let finalResp;

      // Extract tool calls from Responses API output (function_call items)
      const funcCallItems = (jsonResponse.output || []).filter(item => item.type === "function_call");
      const toolCalls = funcCallItems.map((item, idx) => ({
        id: item.call_id || `call_${item.name}_${Date.now()}_${idx}`,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
        }
      }));
      const hasToolCalls = toolCalls.length > 0;

      if (sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI) {
        const candidateTokens = Math.max(0, outTokens - reasoningTokens);
        finalResp = {
          response: {
            candidates: [{ content: { role: "model", parts: [{ text: textContent || "" }] }, finishReason: "STOP", index: 0 }],
            usageMetadata: {
              promptTokenCount: inTokens,
              candidatesTokenCount: candidateTokens,
              totalTokenCount: usage.total_tokens ?? (inTokens + outTokens),
              ...(cacheRead > 0 ? { cachedContentTokenCount: cacheRead } : {}),
              ...(reasoningTokens > 0 ? { thoughtsTokenCount: reasoningTokens } : {})
            },
            modelVersion: model,
            responseId: jsonResponse.id || `resp_${Date.now()}`
          }
        };
      } else {
        const message = { role: "assistant", content: textContent || (hasToolCalls ? null : "") };
        if (hasToolCalls) message.tool_calls = toolCalls;
        const responseDone = jsonResponse.status === "completed" || jsonResponse.status === "done";
        const finishReason = hasToolCalls ? "tool_calls" : (responseDone ? "stop" : (jsonResponse.status || "stop"));
        finalResp = {
          id: jsonResponse.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: jsonResponse.created_at || Math.floor(Date.now() / 1000),
          model: jsonResponse.model || model,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: { prompt_tokens: inTokens, completion_tokens: outTokens, total_tokens: usage.total_tokens ?? (inTokens + outTokens), ...cacheDetails, ...reasoningDetails }
        };
      }

      return { success: true, response: new Response(JSON.stringify(finalResp), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
    } catch (err) {
      console.error("[ChatCore] Responses API SSE→JSON failed:", err);
      if (attemptBudget?.isBudgetError?.(err) || attemptBudget?.snapshot?.().timedOut) {
        return createErrorResult(HTTP_STATUS.SERVICE_UNAVAILABLE, "Standard route attempt budget exhausted");
      }
      if (isClientDisconnect(err, { requestSignal, responseAborted: err?.responseAborted === true })) return createErrorResult(499, "Request aborted");
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, sanitizeConversionErrorMessage(err));
    }
  }

  // Standard Chat Completions SSE path
  try {
    const sseText = await providerResponse.text();
    const parsed = parseSSEToOpenAIResponse(sseText, model);
    if (!parsed) return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");
    if (parsed.error) {
      const upstreamStatus = Number(parsed.error.code || parsed.error.status || 0);
      const status = upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus : HTTP_STATUS.BAD_GATEWAY;
      return createErrorResult(status, parsed.error.message || "Upstream SSE stream failed");
    }

    if (onRequestSuccess) await onRequestSuccess();

    const usage = parsed.usage || {};
    appendLog({ tokens: usage, status: "200 OK" });
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, requestId, silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }));

    const totalLatency = Date.now() - requestStartTime;
    saveRequestDetail(buildRequestDetail({
      ...ctx,
      latency: { ttft: totalLatency, total: totalLatency },
      tokens: usage,
      response: {
        content: parsed.choices?.[0]?.message?.content || null,
        thinking: parsed.choices?.[0]?.message?.reasoning_content || null,
        finish_reason: parsed.choices?.[0]?.finish_reason || "unknown"
      },
      status: "success"
    }, { endpoint: clientRawRequest?.endpoint || null })).catch(() => {});

    // Re-attach usage explicitly. This handler already HAS the correct usage — it is
    // the same object written to the usage DB, and for a cached Claude request that DB
    // row reads cache_read_input_tokens: 11022 — yet the client was observed receiving
    // no usage field at all (verified 2026-08-04 with a fingerprinted payload matched
    // on both sides). Whatever drops it between assembly and serialisation, the client
    // must not be left unable to account for its own token spend: a caller cannot tell
    // a 90%-cached request from a cheap one without this.
    if (usage && Object.keys(usage).length > 0) parsed.usage = usage;

    // Strip reasoning_content only when content is non-empty.
    // When content is empty (e.g. thinking models that used all tokens for reasoning),
    // reasoning_content is the only useful output and must be preserved.
    // Previously this was unconditional, which broke Qwen3.5, Claude extended thinking, etc.
    if (parsed?.choices) {
      for (const choice of parsed.choices) {
        if (choice?.message?.reasoning_content && choice.message.content) {
          delete choice.message.reasoning_content;
        }
      }
    }

    // A Responses-format client (e.g. Codex) forced this provider to stream,
    // but wants JSON back. parseSSEToOpenAIResponse yields a Chat Completions
    // body; convert it to the Responses `output` shape so tool_calls are not
    // lost on the non-streaming return path. Inlined (not imported from
    // nonStreamingHandler.js) to avoid a circular import: nonStreamingHandler
    // already imports parseSSEToOpenAIResponse from this module.
    const finalBody = sourceFormat === FORMATS.OPENAI_RESPONSES
      ? chatCompletionToResponses(parsed, customToolNames)
      : parsed;

    return { success: true, response: new Response(JSON.stringify(finalBody), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
  } catch (err) {
    console.error("[ChatCore] Chat Completions SSE→JSON failed:", err);
    if (attemptBudget?.isBudgetError?.(err) || attemptBudget?.snapshot?.().timedOut) {
      return createErrorResult(HTTP_STATUS.SERVICE_UNAVAILABLE, "Standard route attempt budget exhausted");
    }
    if (isClientDisconnect(err, { requestSignal, responseAborted: err?.responseAborted === true })) return createErrorResult(499, "Request aborted");
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, sanitizeConversionErrorMessage(err));
  }
}


// A forced-stream provider (CommandCode is one) still has to be buffered when
// the client asked for JSON. Large compaction prompts can take tens of seconds;
// returning nothing during that time makes normal HTTP clients assume the
// request died and retry it. JSON permits leading whitespace, so once buffering
// crosses the grace period we keep the connection alive with whitespace and
// append the real JSON document when aggregation finishes.
const FORCED_JSON_HEARTBEAT_GRACE_MS = 5_000;
const FORCED_JSON_HEARTBEAT_MS = 5_000;

export async function handleForcedSSEToJson(context) {
  const { onRouteCommit } = context;
  const buffered = handleForcedSSEToJsonBuffered(context).then(
    (result) => ({ type: "buffered", result }),
    (error) => ({ type: "error", error }),
  );
  const settled = buffered.then((outcome) => {
    if (outcome.type === "buffered") {
      return { result: outcome.result, outcome: deferredOutcomeFromResult(outcome.result) };
    }
    const clientDisconnected = isClientDisconnect(outcome.error, {
      requestSignal: context.requestSignal,
      responseAborted: outcome.error?.responseAborted === true,
    });
    const budgetExhausted = context?.attemptBudget?.isBudgetError?.(outcome.error)
      || context?.attemptBudget?.snapshot?.().timedOut
      || outcome.error?.code === "STANDARD_ROUTE_BUDGET_EXHAUSTED";
    const result = createErrorResult(
      clientDisconnected ? 499 : (budgetExhausted ? HTTP_STATUS.SERVICE_UNAVAILABLE : HTTP_STATUS.BAD_GATEWAY),
      clientDisconnected
        ? "Request aborted"
        : (budgetExhausted ? "Standard route attempt budget exhausted" : (outcome.error?.message || "Failed to convert streaming response to JSON")),
    );
    return { result, outcome: deferredOutcomeFromResult(result) };
  });
  let graceTimer;
  const grace = new Promise((resolve) => {
    graceTimer = setTimeout(() => resolve({ type: "grace" }), FORCED_JSON_HEARTBEAT_GRACE_MS);
  });
  const outcome = await Promise.race([settled, grace]);
  if (outcome?.result !== undefined && outcome?.outcome !== undefined) {
    clearTimeout(graceTimer);
    return outcome.result;
  }

  // The response headers are committed as a 200 once this stream is returned.
  // This branch is intentionally only reached after the normal fast/error grace
  // period; short requests retain their original status and error semantics.
  const encoder = new TextEncoder();
  let heartbeatTimer;
  const stream = new ReadableStream({
    async start(controller) {
      // The heartbeat commits a 200 response. From this point on there is no
      // safe provider fallback, so let the stream stall watchdog—not the
      // standard route deadline—govern the remaining buffered work.
      onRouteCommit?.();
      // The client has already waited out the grace period, so flush one byte
      // right away: every extra silent second moves it closer to its own
      // request deadline. JSON permits this leading whitespace.
      try { controller.enqueue(encoder.encode("\n")); } catch { /* client gone */ }
      heartbeatTimer = setInterval(() => {
        try { controller.enqueue(encoder.encode("\n")); } catch { /* client gone */ }
      }, FORCED_JSON_HEARTBEAT_MS);
      try {
        const { result } = await settled;
        const body = result?.response ? await result.response.text() : JSON.stringify({ error: { message: result?.error || "Request failed" } });
        controller.enqueue(encoder.encode(body));
        controller.close();
      } catch (error) {
        try { controller.error(error); } catch { /* client gone */ }
      } finally {
        clearInterval(heartbeatTimer);
      }
    },
    cancel() {
      clearInterval(heartbeatTimer);
    },
  });
  return {
    success: true,
    deferred: true,
    // The outcome is deliberately observable by the routing coordinator but
    // cannot trigger replay/fallback after the first heartbeat byte commits a
    // 200 response.  It is only used for post-response health/usage telemetry.
    deferredOutcome: settled.then(({ outcome }) => outcome),
    // The response body is intentionally still being produced after this
    // handler returns. captureResponseId must not await clone().json() here,
    // otherwise it defeats the heartbeat and delays the headers until the
    // upstream has completely finished.
    deferResponseId: true,
    response: new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*"
      }
    })
  };
}

function deferredOutcomeFromResult(result) {
  if (!result) return { success: true, status: 200, error: null };
  return {
    success: result.success === true,
    status: Number(result.status || result.response?.status || (result.success ? 200 : HTTP_STATUS.BAD_GATEWAY)),
    error: result.error || null,
    response: result.response || null,
  };
}
