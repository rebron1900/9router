/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

import { readCachedTokens, readCacheWriteTokens } from "../translator/concerns/usage.js";

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!eventMatch || !dataMatch) return;

  const eventType = eventMatch[1].trim();
  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (eventType === "response.completed" || eventType === "response.done") {
    state.status = "completed";
    if (parsed.response?.usage) {
      // Preserve cache and reasoning detail objects. They are part of the
      // Responses usage contract and are otherwise lost when an SSE response
      // is buffered into JSON (which makes Agent cache-rate accounting read 0).
      // Cache aliases go through the shared readers so top-level
      // cache_read_input_tokens / cache_write_input_tokens (Claude-style
      // Responses providers) are counted too, not only the nested details.
      const usage = parsed.response.usage;
      const cachedTokens = readCachedTokens(usage);
      const cacheWriteTokens = readCacheWriteTokens(usage);
      const reasoningTokens = usage.output_tokens_details?.reasoning_tokens
        ?? usage.reasoning_tokens;
      state.usage = {
        ...state.usage,
        input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
        output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? ((usage.input_tokens ?? usage.prompt_tokens ?? 0) + (usage.output_tokens ?? usage.completion_tokens ?? 0)),
        ...((usage.input_tokens_details || cachedTokens > 0 || cacheWriteTokens > 0) ? {
          input_tokens_details: {
            ...(usage.input_tokens_details || {}),
            ...(cachedTokens > 0 ? { cached_tokens: cachedTokens } : {}),
            ...(cacheWriteTokens > 0 ? { cache_write_tokens: cacheWriteTokens } : {}),
          }
        } : {}),
        ...((usage.output_tokens_details || reasoningTokens !== undefined) ? {
          output_tokens_details: {
            ...(usage.output_tokens_details || {}),
            ...(reasoningTokens !== undefined ? { reasoning_tokens: reasoningTokens } : {}),
          }
        } : {}),
      };
    }
  } else if (eventType === "response.failed") {
    state.status = "failed";
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    usage: { ...EMPTY_RESPONSE },
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  // Build output array from accumulated items (ordered by index)
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    output,
    usage: state.usage
  };
}
