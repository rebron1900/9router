import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";
import { createErrorResult, isClientDisconnect } from "../../utils/error.js";
import { extractStandardResponseIdFromChunk } from "@/lib/standardModels/runtime";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey);
}

function streamChunkText(chunk) {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array || ArrayBuffer.isView(chunk)) {
    try { return new TextDecoder().decode(chunk); } catch { return ""; }
  }
  return "";
}

function inspectStreamFailure(chunk) {
  const text = streamChunkText(chunk);
  if (!text) return null;
  const eventMatch = text.match(/(?:^|\n)event:\s*(error|response\.failed)\s*(?:\n|$)/i);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("data:")) continue;
    const data = line.replace(/^\s*data:\s*/, "").trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      const error = parsed?.error || parsed?.response?.error;
      if (error || parsed?.type === "error" || parsed?.type === "response.failed" || eventMatch) {
        return {
          status: Number(error?.status || error?.code) >= 400 ? Number(error.status || error.code) : 502,
          message: String(error?.message || parsed?.message || "Upstream stream failed"),
        };
      }
    } catch {
      // A non-JSON SSE line is not enough to classify as an upstream failure.
    }
  }
  return eventMatch ? { status: 502, message: "Upstream stream failed before response output" } : null;
}

async function primeProviderResponse(providerResponse) {
  const reader = providerResponse.body?.getReader?.();
  if (!reader) return { error: new Error("Upstream stream has no readable body") };
  const bufferedChunks = [];
  let preflightText = "";
  try {
    // A provider can split `event:` and `data:` across transport chunks. Buffer
    // a small number of chunks until the first SSE frame is complete so a
    // pre-commit error is not accidentally exposed as a successful stream.
    while (bufferedChunks.length < 8 && preflightText.length < 128 * 1024) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value === undefined || next.value === null) continue;
      bufferedChunks.push(next.value);
      preflightText += streamChunkText(next.value);
      if (/\r?\n\r?\n/.test(preflightText)) break;
    }
    if (bufferedChunks.length === 0) {
      reader.releaseLock();
      return { error: new Error("Upstream stream ended before response output") };
    }
    const primedBody = new ReadableStream({
      start(controller) {
        for (const chunk of bufferedChunks) controller.enqueue(chunk);
      },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            reader.releaseLock();
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          try { reader.releaseLock(); } catch { /* already released */ }
          controller.error(error);
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } finally { try { reader.releaseLock(); } catch { /* already released */ } }
      },
    });
    return {
      firstChunk: preflightText,
      response: new Response(primedBody, {
        status: providerResponse.status,
        statusText: providerResponse.statusText,
        headers: providerResponse.headers,
      }),
    };
  } catch (error) {
    try { await reader.cancel(error); } catch { /* best effort */ }
    try { reader.releaseLock(); } catch { /* already released */ }
    return { error };
  }
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, pxpipe, reqTag, log, credentials, preflightStream = false, onResponseId = null }) {
  if (onRequestSuccess && !preflightStream) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx error
  // page), piping it through the SSE transform stream causes Next.js
  // "failed to pipe response" and crashes the chat router. Read the body,
  // pull a short human-readable message from the <title>, sanitize it, and
  // return a clean JSON error instead. The message is stripped of HTML tags
  // and clamped so untrusted upstream text never reaches the client verbatim
  // (the UI may render error.message as HTML).
  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    const bodyText = await providerResponse.text().catch(() => '');
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
    const shortMsg = sanitizedTitle
      || (bodyText.length < 200 ? bodyText.replace(/<[^>]*>/g, '').trim().slice(0, 160) : `Upstream returned non-SSE response (${upstreamContentType})`);
    const status = providerResponse.status || 502;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · non-SSE (${upstreamContentType})\n    ${shortMsg}`);
    else console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`);
    streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`));
    return {
      success: false,
      response: new Response(JSON.stringify({ error: { message: `[${status}]: ${shortMsg}` } }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }

  let firstChunk = null;
  if (preflightStream) {
    const primed = await primeProviderResponse(providerResponse);
    if (primed.error) {
      streamController?.handleError?.(primed.error);
      // A client that disappears mid-preflight is not a provider failure. Report
      // 499 so the coordinator neither cools the account down nor fails over.
      // Checked before the 502: `ResponseAborted` carries an empty message, so
      // folding it into the generic text below would erase the only signal.
      if (isClientDisconnect(primed.error)) {
        return createErrorResult(499, "Request aborted");
      }
      return createErrorResult(502, `Upstream stream failed before response output: ${primed.error.message}`);
    }
    firstChunk = primed.firstChunk;
    const failure = inspectStreamFailure(firstChunk);
    if (failure) {
      streamController?.handleError?.(new Error(failure.message));
      return createErrorResult(failure.status, failure.message);
    }
    providerResponse = primed.response;
    const firstResponseId = extractStandardResponseIdFromChunk(firstChunk);
    if (firstResponseId) onResponseId?.(firstResponseId);
    if (onRequestSuccess) {
      Promise.resolve()
        .then(onRequestSuccess)
        .catch(err => console.error("[ChatCore] onRequestSuccess failed:", err?.message || err));
    }
  }

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials });

  // Responses passthrough: synthesize response.failed + [DONE] if the stream aborts/stalls before a terminal event
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough ? buildAbortedResponsesTerminalBytes : null;
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  const onResponseChunk = (chunk) => {
    const responseId = extractStandardResponseIdFromChunk(chunk);
    if (responseId) onResponseId?.(responseId);
  };
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs, onResponseChunk, onResponseChunk);

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    pxpipe,
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(transformedBody, { headers: SSE_HEADERS })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, reqTag, log }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      pxpipe,
      status: "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    // Persist stream usage to DB (no console line; the "📊 done" line below is authoritative)
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE", silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency }));
  };

  return { onStreamComplete, streamDetailId };
}
