/**
 * OpenAI → CommandCode request translator
 *
 * Upstream `/alpha/generate` schema (verified live with curl 2026-05-07):
 *  - params.system: STRING at top level (Anthropic-style; system messages NOT allowed in messages[])
 *  - params.messages[*].role ∈ {"user","assistant","tool"}
 *  - params.messages[*].content: Array of content blocks (NEVER a string)
 *  - tool_use blocks (assistant): {type:"tool-call", toolCallId, toolName, input}
 *  - tool_result blocks (role=user): {type:"tool-result", toolCallId, toolName, output}
 *  - tools[*]: Anthropic plain {name, description, input_schema}
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { randomUUID } from "crypto";
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";
import { DEFAULT_MAX_TOKENS } from "../../config/runtimeConfig.js";
import { parseDataUri } from "../concerns/image.js";

function flattenText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p === "object" && typeof p.text === "string") parts.push(p.text);
    }
    return parts.join("\n");
  }
  return String(content);
}

function toCommandCodeImage(part) {
  const rawImageUrl = part?.type === RESPONSES_ITEM.INPUT_IMAGE ? part.image_url : part?.image_url;
  const url = typeof rawImageUrl === "string" ? rawImageUrl : rawImageUrl?.url;
  const parsed = parseDataUri(url);
  if (parsed) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: parsed.mimeType,
        data: parsed.base64,
      },
    };
  }

  // Some native/adapter clients use the Claude-style image block even when
  // calling an OpenAI-compatible endpoint. If the attachment has already
  // been materialized into base64, preserve it instead of turning it into a
  // text placeholder. A bare attachment reference is intentionally not
  // dereferenced here: 9router does not own the client's attachment store.
  const source = part?.source;
  if (source?.type === "base64" && typeof source.data === "string") {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: source.media_type || source.mimeType || "image/png",
        data: source.data,
      },
    };
  }

  return {
    type: "text",
    text: "[image omitted: unable to fetch image for CommandCode]",
  };
}

function toContentBlocks(content) {
  if (content == null) return [{ type: OPENAI_BLOCK.TEXT, text: "" }];
  if (typeof content === "string") return [{ type: OPENAI_BLOCK.TEXT, text: content }];
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (typeof part === "string") {
        blocks.push({ type: OPENAI_BLOCK.TEXT, text: part });
      } else if (part && typeof part === "object") {
        if (part.type === OPENAI_BLOCK.TEXT && typeof part.text === "string") {
          blocks.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
        } else if (
          part.type === OPENAI_BLOCK.IMAGE_URL ||
          part.type === OPENAI_BLOCK.IMAGE ||
          part.type === RESPONSES_ITEM.INPUT_IMAGE
        ) {
          const image = toCommandCodeImage(part);
          // Remote images are normally converted by prefetchRemoteImages()
          // before this translator runs. Keep a clear placeholder if the
          // guarded fetch failed instead of sending an unsupported URL shape.
          blocks.push(image);
        } else if (typeof part.text === "string") {
          blocks.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
        }
      }
    }
    return blocks.length ? blocks : [{ type: OPENAI_BLOCK.TEXT, text: "" }];
  }
  return [{ type: OPENAI_BLOCK.TEXT, text: String(content) }];
}

function safeParseJson(s) {
  if (s == null) return {};
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return {}; }
}

function convertMessages(messages = []) {
  const out = [];
  const systemTexts = [];

  for (const m of messages) {
    if (!m) continue;
    const role = m.role;

    if (role === ROLE.SYSTEM) {
      const t = flattenText(m.content);
      if (t) systemTexts.push(t);
      continue;
    }

    if (role === ROLE.TOOL) {
      const value = typeof m.content === "string" ? m.content : flattenText(m.content);
      out.push({
        role: ROLE.TOOL,
        content: [{
          type: "tool-result",
          toolCallId: m.tool_call_id || "",
          toolName: m.name || "",
          output: { type: "text", value },
        }],
      });
      continue;
    }

    if (role === ROLE.ASSISTANT) {
      const blocks = [];
      // Thinking mode requires the previous turn's reasoning to be echoed back,
      // or the upstream rejects the request with "reasoning_content in the
      // thinking mode must be passed back to the API". The Responses hop
      // (request/openai-responses.js) already attached it to this message;
      // carry it through as a leading reasoning block so it is not dropped.
      // Deliberately a length check, not a trim(): reasoningContentInjector
      // satisfies this upstream requirement with a single-space placeholder,
      // so a whitespace-only value must still be forwarded.
      const reasoning = typeof m.reasoning_content === "string" && m.reasoning_content.length > 0
        ? m.reasoning_content
        : (typeof m.reasoning === "string" && m.reasoning.length > 0 ? m.reasoning : "");
      if (reasoning) blocks.push({ type: RESPONSES_ITEM.REASONING, text: reasoning });
      const text = flattenText(m.content);
      if (text) blocks.push({ type: OPENAI_BLOCK.TEXT, text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          blocks.push({
            type: "tool-call",
            toolCallId: tc.id || "",
            toolName: fn.name || "",
            input: safeParseJson(fn.arguments),
          });
        }
      }
      out.push({ role: ROLE.ASSISTANT, content: blocks.length ? blocks : [{ type: OPENAI_BLOCK.TEXT, text: "" }] });
      continue;
    }

    out.push({ role: ROLE.USER, content: toContentBlocks(m.content) });
  }

  return { messages: out, system: systemTexts.join("\n\n") };
}

function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const result = [];
  for (const t of tools) {
    if (!t) continue;
    if (t.type === OPENAI_BLOCK.FUNCTION && t.function) {
      result.push({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: "object" },
      });
    } else if (t.name && (t.input_schema || t.parameters)) {
      result.push({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema || t.parameters,
      });
    }
  }
  return result.length ? result : undefined;
}

export function openaiToCommandCodeRequest(model, body, stream /* , credentials */) {
  const { messages, system } = convertMessages(body.messages);
  const params = {
    model,
    messages,
    stream: stream !== false,
    max_tokens: body.max_tokens ?? body.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    temperature: body.temperature ?? 0.3,
  };

  if (system) params.system = system;

  const tools = convertTools(body.tools);
  if (tools) params.tools = tools;
  if (body.top_p != null) params.top_p = body.top_p;

  const today = new Date().toISOString().slice(0, 10);

  return {
    threadId: randomUUID(),
    memory: "",
    config: {
      workingDir: process.cwd(),
      date: today,
      environment: process.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    params,
  };
}

register(FORMATS.OPENAI, FORMATS.COMMANDCODE, openaiToCommandCodeRequest, null);
