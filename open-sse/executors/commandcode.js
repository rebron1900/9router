import { randomUUID } from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { commandCodeToOpenAIResponse } from "../translator/response/commandcode-to-openai.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { dbg } from "../utils/debugLog.js";

function countCommandCodeImages(body) {
  return (body?.params?.messages || []).reduce((total, message) => {
    if (!Array.isArray(message?.content)) return total;
    return total + message.content.filter((block) => block?.type === "image").length;
  }, 0);
}

/**
 * CommandCodeExecutor — talks to https://api.commandcode.ai/alpha/generate
 *
 * Auth: Bearer <user_xxx> API key (stored as the connection's apiKey).
 * Adds the per-request `x-session-id` header expected by CommandCode upstream.
 *
 * Upstream returns AI SDK v5 NDJSON (one JSON event per line, no `data:` prefix).
 * We translate each event to an OpenAI chat.completion.chunk and emit it as SSE so
 * both the streaming and non-streaming (forced SSE → JSON) downstream handlers in
 * 9router can consume it without further format translation.
 */
export class CommandCodeExecutor extends BaseExecutor {
  constructor() {
    super("commandcode", PROVIDERS.commandcode);
  }

  transformRequest(model, body, stream, credentials) {
    body.stream = true;
    return body;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...(this.config.headers || {}),
      "x-session-id": randomUUID(),
    };

    const token = credentials?.apiKey || credentials?.accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  async execute(opts) {
    const imageCount = countCommandCodeImages(opts?.body);
    dbg("COMMANDCODE", `execute start | images=${imageCount} | model=${opts?.model || "unknown"}`);
    const result = await super.execute(opts);
    if (!result?.response?.ok || !result.response.body) return result;
    // The upstream sends `start`/`start-step` before it starts the expensive
    // generation/compaction phase.  Never await a read from that body here:
    // chatCore must be able to start its forced-JSON keepalive as soon as fetch
    // returns headers.  The wrapper below consumes and translates the body
    // asynchronously while preserving every event in order.
    result.response = inspectAndWrapCommandCodeResponse(result.response, opts.model, imageCount);
    return result;
  }

  parseError(response, bodyText) {
    let parsed = null;
    try {
      parsed = JSON.parse(bodyText || "{}");
    } catch {
      parsed = null;
    }
    const errObj = parsed?.error || parsed;
    const msg = errObj?.message || parsed?.message || bodyText || response.statusText;
    const status = Number(errObj?.code || errObj?.statusCode || response.status) || response.status;
    return {
      status,
      message: msg || `CommandCode upstream error: ${response.status}`,
    };
  }
}

export function parseCommandCodeError(event) {
  if (!event || typeof event !== "object") {
    return {
      statusCode: 503,
      message: "CommandCode upstream error",
      type: "server_error",
    };
  }

  const errVal = event.error ?? event.message ?? "unknown";
  let message = "";
  let statusCode = null;
  let type = "server_error";

  if (typeof errVal === "object" && errVal !== null) {
    message = errVal.message || errVal.error || JSON.stringify(errVal);
    if (errVal.statusCode && Number.isInteger(Number(errVal.statusCode))) {
      statusCode = Number(errVal.statusCode);
    } else if (errVal.status && Number.isInteger(Number(errVal.status))) {
      statusCode = Number(errVal.status);
    }
    if (errVal.type) type = errVal.type;
  } else if (typeof errVal === "string") {
    message = errVal;
  } else {
    message = JSON.stringify(errVal);
  }

  if (event.statusCode && Number.isInteger(Number(event.statusCode))) {
    statusCode = Number(event.statusCode);
  }

  if (!statusCode || statusCode < 400 || statusCode > 599) {
    const lower = message.toLowerCase();
    if (lower.includes("rate limit") || lower.includes("too many requests")) {
      statusCode = 429;
      type = "rate_limit_error";
    } else if (lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("authentication")) {
      statusCode = 401;
      type = "authentication_error";
    } else if (lower.includes("payment required") || lower.includes("billing")) {
      statusCode = 402;
      type = "billing_error";
    } else if (lower.includes("quota") || lower.includes("forbidden") || lower.includes("permission")) {
      statusCode = 403;
      type = "permission_error";
    } else if (lower.includes("not found")) {
      statusCode = 404;
      type = "invalid_request_error";
    } else if (lower.includes("unavailable") || lower.includes("overloaded") || lower.includes("server error")) {
      statusCode = 503;
      type = "server_error";
    } else {
      statusCode = 503;
    }
  }

  return { statusCode, message, type };
}

export function inspectAndWrapCommandCodeResponse(originalResponse, model, imageCount = 0) {
  if (!originalResponse?.body) return originalResponse;
  return wrapNdjsonAsOpenAISse(originalResponse.body, model, originalResponse, imageCount);
}

function commandCodeErrorChunk(line) {
  const jsonStr = String(line || "").trim();
  if (!jsonStr || jsonStr === "[DONE]") return null;
  const payload = jsonStr.startsWith("data:") ? jsonStr.slice(5).trim() : jsonStr;
  let event;
  try { event = JSON.parse(payload); } catch { return null; }
  if (event?.type !== "error") return null;
  const { statusCode, message, type } = parseCommandCodeError(event);
  return {
    error: {
      message: `[CommandCode error: ${message}]`,
      type,
      code: statusCode,
    },
  };
}

function wrapNdjsonAsOpenAISse(streamBody, model, originalResponse = null, imageCount = 0) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state = { model };

  const emitChunks = (chunks, controller) => {
    if (!chunks) return;
    const list = Array.isArray(chunks) ? chunks : [chunks];
    for (const c of list) {
      if (c == null) continue;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
    }
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const errorChunk = commandCodeErrorChunk(trimmed);
        if (errorChunk) emitChunks(errorChunk, controller);
        else emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
    },
    flush(controller) {
      const trimmed = buffer.trim();
      if (trimmed) {
        const errorChunk = commandCodeErrorChunk(trimmed);
        if (errorChunk) emitChunks(errorChunk, controller);
        else emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
      if (imageCount > 0) {
        dbg("COMMANDCODE", `visual proof token=${state.visualProofSeen ? "seen" : "not-seen"} | images=${imageCount}`);
      }
      controller.enqueue(encoder.encode(SSE_DONE));
    },
  });

  const newBody = streamBody.pipeThrough(transform);
  const headers = originalResponse?.headers ? Object.fromEntries(originalResponse.headers.entries()) : {};
  delete headers["content-length"];
  delete headers["content-encoding"];
  return new Response(newBody, {
    status: originalResponse?.status || 200,
    statusText: originalResponse?.statusText || "OK",
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...headers,
      "content-type": "text/event-stream",
    },
  });
}

export default CommandCodeExecutor;
