// Strip multimodal content blocks a model cannot read, BEFORE translation.
// Driven by getCapabilitiesForModel: vision/audioInput/pdf. Replaces removed
// media with a short text placeholder so messages never become empty.
import { FORMATS } from "../formats.js";

// Placeholder text inserted where a media block was removed.
// Current turn: explain the active model can't read what the user just sent.
const PLACEHOLDER_CURRENT = {
  vision: "[image omitted: model has no vision support]",
  audioInput: "[audio omitted: model has no audio support]",
  pdf: "[file omitted: model has no document support]",
};
// Earlier turns: neutral (a combo may route to a different model each turn).
const PLACEHOLDER_PREV = {
  vision: "[Previous image omitted from context.]",
  audioInput: "[Previous audio omitted from context.]",
  pdf: "[Previous file omitted from context.]",
};
const ph = (cap, isLast) => (isLast ? PLACEHOLDER_CURRENT : PLACEHOLDER_PREV)[cap];

// Map gemini inlineData/fileData mime prefix -> capability it requires.
function capForMime(mime) {
  if (typeof mime !== "string") return null;
  if (mime.startsWith("image/")) return "vision";
  if (mime.startsWith("audio/")) return "audioInput";
  if (mime === "application/pdf") return "pdf";
  return null;
}

// OpenAI chat content block -> required capability (null = plain text/other, keep).
function capForOpenAIBlock(block) {
  const t = block?.type;
  if (t === "image_url" || t === "image" || t === "input_image") return "vision";
  if (t === "input_audio" || t === "audio_url") return "audioInput";
  if (t === "file") return "pdf";
  return null;
}

function isImageAttachment(value) {
  if (!value || typeof value !== "object") return false;
  const mime = value.contentType || value.mediaType || value.media_type;
  if (typeof mime === "string" && mime.toLowerCase().startsWith("image/")) return true;
  if (typeof value.url === "string" && value.url.toLowerCase().startsWith("data:image/")) return true;
  return typeof value.data === "string" || typeof value.base64 === "string";
}

/**
 * Count image-like inputs without inspecting or logging their contents.
 * This is diagnostic-only and intentionally includes native attachment
 * blocks so an adapter/serialization loss is visible at the gateway edge.
 */
export function countImageInputs(body, sourceFormat) {
  if (!body) return 0;
  const countBlocks = (blocks) => Array.isArray(blocks)
    ? blocks.filter((block) => capForOpenAIBlock(block) === "vision" || capForClaudeBlock(block) === "vision").length
    : 0;
  const countMessage = (message) => {
    if (!message || typeof message !== "object") return 0;
    let total = countBlocks(message.content);
    if (Array.isArray(message.images)) total += message.images.length;
    for (const attachments of [message.experimental_attachments, message.attachments]) {
      if (Array.isArray(attachments)) total += attachments.filter(isImageAttachment).length;
    }
    if (message.image_url || message.image) total += 1;
    if (typeof message.content === "string" && message.content.includes("data:image/")) total += 1;
    return total;
  };

  switch (sourceFormat) {
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
    case FORMATS.CODEX:
      // /v1/responses normally reaches chatCore with input[]. Some adapter
      // implementations first materialize the same request as messages[];
      // keep diagnostics truthful in both shapes.
      if (Array.isArray(body.input)) {
        return body.input.reduce(
          (total, item) => total + countBlocks(item?.content) + (capForOpenAIBlock(item) === "vision" ? 1 : 0),
          0,
        );
      }
      return (body.messages || []).reduce((total, message) => total + countMessage(message), 0);
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      return (body.contents || []).reduce((total, item) => total + (item?.parts || []).filter((part) => capForMime(part?.inlineData?.mimeType || part?.fileData?.mimeType) === "vision").length, 0);
    case FORMATS.ANTIGRAVITY:
      return (body?.request?.contents || []).reduce((total, item) => total + (item?.parts || []).filter((part) => capForMime(part?.inlineData?.mimeType || part?.fileData?.mimeType) === "vision").length, 0);
    default:
      return (body.messages || []).reduce((total, message) => total + countMessage(message), 0);
  }
}

/**
 * Redacted wire-shape summary for multimodal troubleshooting. It reports only
 * container names and block types, never URLs, attachment ids, prompts, or
 * image bytes.
 */
export function summarizeInputShapes(body) {
  if (!body || typeof body !== "object") return "none";
  const parts = [];
  const summarize = (label, entries) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const blocks = Array.isArray(entry?.content)
        ? entry.content.map((block) => String(block?.type || typeof block)).slice(0, 12)
        : [];
      parts.push(`${label}:${String(entry?.type || entry?.role || "item")}[${blocks.join(",")}]`);
    }
  };
  summarize("input", body.input);
  summarize("messages", body.messages);
  summarize("contents", body.contents || body.request?.contents);
  if (Array.isArray(body.images)) parts.push(`root-images:${body.images.length}`);
  return parts.length > 0 ? parts.slice(0, 12).join("|") : "none";
}

// Claude content block -> required capability.
function capForClaudeBlock(block) {
  const t = block?.type;
  if (t === "image") return "vision";
  if (t === "document") return "pdf";
  return null;
}

// Filter an array of content blocks; drop unsupported, inject one placeholder per kind.
// isLast = block belongs to the current user turn (picks the explanatory placeholder).
function filterBlocks(blocks, capOf, caps, removed, isLast) {
  const out = [];
  for (const block of blocks) {
    const cap = capOf(block);
    if (cap && caps[cap] === false) { removed.add(cap); continue; }
    out.push(block);
  }
  for (const cap of removed) out.push({ type: "text", text: ph(cap, isLast) });
  return out;
}

// OpenAI / OpenAI-compatible chat messages[].content[].
function stripOpenAI(body, caps) {
  if (!Array.isArray(body.messages)) return;
  const last = body.messages.length - 1;
  body.messages.forEach((msg, i) => {
    if (caps.vision === false) {
      if (Array.isArray(msg.images)) delete msg.images;
      if (Array.isArray(msg.experimental_attachments)) {
        msg.experimental_attachments = msg.experimental_attachments.filter(
          (a) => !(a?.contentType?.startsWith("image/") || (typeof a?.url === "string" && a.url.startsWith("data:image/")))
        );
      }
      if (Array.isArray(msg.attachments)) {
        msg.attachments = msg.attachments.filter(
          (a) => !(a?.contentType?.startsWith("image/") || (typeof a?.url === "string" && a.url.startsWith("data:image/")))
        );
      }
    }
    if (!Array.isArray(msg.content)) return;
    const removed = new Set();
    msg.content = filterBlocks(msg.content, capForOpenAIBlock, caps, removed, i === last);
  });
}

// Claude messages[].content[].
function stripClaude(body, caps) {
  if (!Array.isArray(body.messages)) return;
  const last = body.messages.length - 1;
  body.messages.forEach((msg, i) => {
    if (!Array.isArray(msg.content)) return;
    const removed = new Set();
    msg.content = filterBlocks(msg.content, capForClaudeBlock, caps, removed, i === last);
  });
}

// OpenAI Responses input[].content[] -> required capability. Must match the
// vision/in-out detection in capForOpenAIBlock so counting and stripping agree:
// a block counted as an image must also be strippable when vision is unsupported.
function capForResponsesBlock(block) {
  const t = block?.type;
  if (t === "input_image" || t === "image_url" || t === "image") return "vision";
  if (t === "input_file") return "pdf";
  return null;
}

// OpenAI Responses input[].content[] (input_image / image / image_url / input_file).
function stripResponses(body, caps) {
  if (!Array.isArray(body.input)) return;
  const last = body.input.length - 1;
  body.input.forEach((item, i) => {
    if (!Array.isArray(item.content)) return;
    const removed = new Set();
    item.content = item.content.filter((b) => {
      const cap = capForResponsesBlock(b);
      if (cap && caps[cap] === false) { removed.add(cap); return false; }
      return true;
    });
    for (const cap of removed) item.content.push({ type: "input_text", text: ph(cap, i === last) });
  });
}

// Gemini / gemini-cli contents[].parts[] (inlineData / fileData by mime).
function stripGeminiParts(contents, caps) {
  if (!Array.isArray(contents)) return;
  const last = contents.length - 1;
  contents.forEach((c, i) => {
    if (!Array.isArray(c.parts)) return;
    const removed = new Set();
    c.parts = c.parts.filter((p) => {
      const mime = p?.inlineData?.mimeType || p?.fileData?.mimeType;
      const cap = capForMime(mime);
      if (cap && caps[cap] === false) { removed.add(cap); return false; }
      return true;
    });
    for (const cap of removed) c.parts.push({ text: ph(cap, i === last) });
  });
}

/**
 * Remove media blocks the model can't read, in-place on the source-format body.
 * @param {object} body - request body (source format)
 * @param {string} sourceFormat - one of FORMATS
 * @param {object} caps - capabilities from getCapabilitiesForModel
 * @returns {boolean} true if anything was stripped-eligible (cap false for some modality)
 */
export function stripUnsupportedModalities(body, sourceFormat, caps) {
  if (!body || !caps) return false;
  // Fast exit: model supports everything we'd strip.
  if (caps.vision !== false && caps.audioInput !== false && caps.pdf !== false) return false;

  switch (sourceFormat) {
    case FORMATS.OPENAI:
    case FORMATS.OLLAMA:
    case FORMATS.KIRO:
    case FORMATS.CURSOR:
    case FORMATS.COMMANDCODE:
      stripOpenAI(body, caps);
      break;
    case FORMATS.CLAUDE:
      stripClaude(body, caps);
      break;
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
    case FORMATS.CODEX:
      stripResponses(body, caps);
      break;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      stripGeminiParts(body.contents, caps);
      break;
    case FORMATS.ANTIGRAVITY:
      stripGeminiParts(body?.request?.contents, caps);
      break;
    default:
      stripOpenAI(body, caps);
  }
  return true;
}
