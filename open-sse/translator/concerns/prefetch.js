// Pre-fetch remote image URLs into base64 BEFORE translation, for target
// formats whose upstream providers cannot fetch remote URLs themselves
// (they require inline base64). Runs on the source-format body.
import { FORMATS } from "../formats.js";
import { fetchImageAsBase64, parseDataUri } from "./image.js";

// Targets that require inline base64 images (cannot accept remote URLs).
const TARGETS_NEED_BASE64 = new Set([
  FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX,
  FORMATS.ANTIGRAVITY, FORMATS.OLLAMA, FORMATS.KIRO, FORMATS.COMMANDCODE,
]);

function isRemoteUrl(url) {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

// Collect {get,set} accessors for every remote image URL in a source body.
function collectImageRefs(body, sourceFormat) {
  const refs = [];
  // Collect refs from one content[] array. Shared by OpenAI chat messages and
  // OpenAI Responses input items (both use the same image block shapes).
  const collectContent = (content) => {
    for (const block of content || []) {
      if (block?.type === "image_url" || block?.type === "input_image") {
        const url = typeof block.image_url === "string" ? block.image_url : block.image_url?.url;
        if (isRemoteUrl(url)) refs.push({ get: () => url, set: (v) => {
          if (typeof block.image_url === "string") block.image_url = v.url; else block.image_url.url = v.url;
        } });
      } else if (block?.type === "image" && block.source?.type === "url" && isRemoteUrl(block.source.url)) {
        // Native adapters may send a Claude-style image block through an
        // OpenAI-compatible route. Normalize its remote source as well.
        refs.push({ get: () => block.source.url, set: (v) => {
          block.source = { type: "base64", media_type: v.mimeType, data: v.url.split(",")[1] };
        } });
      }
      // `image` blocks that only carry an attachment/file_id reference cannot
      // be dereferenced here — skip them rather than throwing.
    }
  };
  const pushOpenAI = (messages) => {
    for (const msg of messages || []) {
      if (!Array.isArray(msg.content)) continue;
      collectContent(msg.content);
    }
  };
  // /v1/responses carries images in input[].content[]; body.messages is absent.
  // `input` may be a plain string — only array input has image blocks.
  const pushResponses = (input) => {
    if (!Array.isArray(input)) return;
    for (const item of input) {
      if (!Array.isArray(item?.content)) continue;
      collectContent(item.content);
    }
  };
  const pushGemini = (contents) => {
    for (const c of contents || []) {
      for (const p of c.parts || []) {
        const uri = p?.fileData?.fileUri;
        if (isRemoteUrl(uri)) refs.push({ get: () => uri, part: p });
      }
    }
  };

  switch (sourceFormat) {
    case FORMATS.OPENAI:
    case FORMATS.OLLAMA:
    case FORMATS.KIRO:
    case FORMATS.CURSOR:
    case FORMATS.COMMANDCODE:
      pushOpenAI(body.messages);
      break;
    case FORMATS.CLAUDE:
      for (const msg of body.messages || []) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block?.type === "image" && block.source?.type === "url" && isRemoteUrl(block.source.url)) {
            refs.push({ get: () => block.source.url, claudeBlock: block });
          }
        }
      }
      break;
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
    case FORMATS.CODEX:
      pushResponses(body.input);
      break;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      pushGemini(body.contents);
      break;
    case FORMATS.ANTIGRAVITY:
      pushGemini(body?.request?.contents);
      break;
    default:
      pushOpenAI(body.messages);
  }
  return refs;
}

/**
 * Replace remote image URLs with base64 data when the target needs inline data.
 * No-op when target accepts remote URLs (e.g. openai, claude) or body has none.
 * @returns {Promise<number>} count of images converted
 */
export async function prefetchRemoteImages(body, sourceFormat, targetFormat, options = {}) {
  if (!body || !TARGETS_NEED_BASE64.has(targetFormat)) return 0;
  const refs = collectImageRefs(body, sourceFormat);
  if (!refs.length) return 0;

  let converted = 0;
  for (const ref of refs) {
    const url = ref.get();
    if (parseDataUri(url)) continue; // already inline
    const fetched = await fetchImageAsBase64(url, options);
    if (!fetched) continue;
    if (ref.set) ref.set(fetched);
    else if (ref.part) { delete ref.part.fileData; ref.part.inlineData = { mimeType: fetched.mimeType, data: fetched.url.split(",")[1] }; }
    else if (ref.claudeBlock) ref.claudeBlock.source = { type: "base64", media_type: fetched.mimeType, data: fetched.url.split(",")[1] };
    converted++;
  }
  return converted;
}
