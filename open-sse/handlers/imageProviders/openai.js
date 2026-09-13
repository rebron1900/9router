// OpenAI-compatible adapter (used by openai, minimax, openrouter, recraft)
import { PROVIDER_MEDIA } from "../../providers/index.js";

const imageCfg = (id) => PROVIDER_MEDIA[id]?.imageConfig || {};
const imageUrl = (id) => imageCfg(id).baseUrl;

function isFormData(value) {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

function base64ToBytes(value) {
  if (typeof Buffer !== "undefined") return Buffer.from(value, "base64");
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function dataUrlToBlob(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^data:([^;,]+);base64,([\s\S]*)$/i);
  if (!match || typeof Blob === "undefined") return null;
  return new Blob([base64ToBytes(match[2].replace(/\s+/g, ""))], { type: match[1] });
}

function filenameForMime(mime, index) {
  const extension = String(mime || "image/png").split("/")[1] || "png";
  return `image-${index + 1}.${extension === "jpeg" ? "jpg" : extension}`;
}

function imageValues(body) {
  const values = [];
  if (Array.isArray(body?.images)) values.push(...body.images);
  if (!Array.isArray(body?.images) && body?.image !== undefined) values.push(body.image);
  return values.filter((value) => typeof value === "string" && value.trim());
}

function buildEditBody(model, body) {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", String(body.prompt || ""));
  form.append("n", String(body.n ?? 1));
  form.append("size", String(body.size || "1024x1024"));

  for (const field of [
    "quality",
    "background",
    "input_fidelity",
    "output_format",
    "output_compression",
    "response_format",
    "style",
  ]) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== "") {
      form.append(field, String(body[field]));
    }
  }

  imageValues(body).forEach((value, index) => {
    const blob = dataUrlToBlob(value);
    if (blob) form.append("image", blob, filenameForMime(blob.type, index));
    else form.append("image", value);
  });

  const mask = body.mask_image || body.maskImage || body.mask || body.maskimage;
  const maskBlob = dataUrlToBlob(mask);
  if (maskBlob) form.append("mask", maskBlob, filenameForMime(maskBlob.type, 0));
  else if (typeof mask === "string" && mask.trim()) form.append("mask", mask);
  return form;
}

function hasContentTypeHeader(headers) {
  return Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
}

export default function createOpenAIAdapter(providerId) {
  const cfg = imageCfg(providerId);
  return {
    buildUrl: (_model, _credentials, body = {}) => {
      const isEdit = body?._imageOperation === "edit" || body?.image_operation === "edit";
      if (!isEdit) return imageUrl(providerId);
      if (cfg.editBaseUrl || cfg.editUrl) return cfg.editBaseUrl || cfg.editUrl;
      return imageUrl(providerId)?.replace(/\/generations(?=$|[?#])/i, "/edits");
    },
    buildHeaders: (creds, requestBody) => {
      const headers = { "Content-Type": "application/json", ...(cfg.headers || {}) };
      if (isFormData(requestBody)) {
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === "content-type") delete headers[key];
        }
      } else if (!hasContentTypeHeader(headers)) {
        headers["Content-Type"] = "application/json";
      }
      const key = creds?.apiKey || creds?.accessToken;
      if (key) headers["Authorization"] = `Bearer ${key}`;
      return headers;
    },
    buildBody: (model, body) => {
      const isEdit = body?._imageOperation === "edit" || body?.image_operation === "edit";
      if (isEdit) return buildEditBody(model, body);
      const { prompt, n = 1, size = "1024x1024", quality, style, response_format } = body;
      const full = { model, prompt, n, size };
      if (quality) full.quality = quality;
      if (body.background) full.background = body.background;
      if (style) full.style = style;
      if (response_format) full.response_format = response_format;
      // bodyFields whitelist (e.g. xAI accepts only model/prompt/n/response_format)
      if (Array.isArray(cfg.bodyFields)) {
        const req = {};
        for (const f of cfg.bodyFields) if (full[f] !== undefined) req[f] = full[f];
        return req;
      }
      return full;
    },
    normalize: (responseBody) => responseBody,
  };
}
