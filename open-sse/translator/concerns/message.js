import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse an OpenAI content-part array: when every part is text the array
// becomes a plain string (joined with newlines), otherwise it is returned as-is.
export function collapseTextParts(parts) {
  if (parts.every((p) => p.type === OPENAI_BLOCK.TEXT)) {
    return parts.map((p) => p.text || "").join("\n");
  }
  return parts;
}
