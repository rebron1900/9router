import { IMAGE_SIGNATURES, MAX_IMAGE_BYTES } from "open-sse/config/mediaConfig.js";

const IMAGE_FIELD_RE = /^(?:image|images)(?:\[\d*\])?$/i;
const MASK_FIELD_NAMES = new Set(["mask", "mask_image", "maskimage"]);
const SCALAR_FIELDS = [
  "model",
  "prompt",
  "n",
  "size",
  "quality",
  "background",
  "input_fidelity",
  "output_format",
  "output_compression",
  "response_format",
  "style",
  "image_detail",
  "stream",
  "partial_images",
];

const MIME_BY_EXTENSION = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export class ImageRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ImageRequestError";
    this.status = status;
  }
}

function isFileLike(value) {
  return !!value
    && typeof value === "object"
    && typeof value.arrayBuffer === "function"
    && (typeof value.size === "number" || typeof value.type === "string");
}

function detectImageMime(bytes) {
  for (const { sig, offset, mime, verifyWebp } of IMAGE_SIGNATURES) {
    if (bytes.length < offset + sig.length) continue;
    if (!sig.every((byte, index) => bytes[offset + index] === byte)) continue;
    if (verifyWebp && !(bytes.length >= 12
      && bytes[8] === 0x57 && bytes[9] === 0x45
      && bytes[10] === 0x42 && bytes[11] === 0x50)) continue;
    return mime;
  }
  return null;
}

function declaredImageMime(value) {
  const mime = String(value || "").trim().toLowerCase();
  if (mime === "image/jpg") return "image/jpeg";
  return mime.startsWith("image/") ? mime : null;
}

function extensionImageMime(name) {
  const extension = String(name || "").split(".").pop()?.toLowerCase();
  return MIME_BY_EXTENSION[extension] || null;
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function fileToDataUrl(file) {
  const declaredSize = Number(file.size);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) {
    throw new ImageRequestError(`Image file exceeds the ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB limit`);
  }

  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new ImageRequestError("Unable to read image file");
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageRequestError(`Image file exceeds the ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB limit`);
  }

  const mime = detectImageMime(bytes)
    || declaredImageMime(file.type)
    || extensionImageMime(file.name)
    || null;
  if (!mime) throw new ImageRequestError("Unsupported image file type");
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

function normalizeStringImage(value) {
  const text = value.trim();
  if (!text) return null;
  if (/^data:image\//i.test(text) || /^https?:\/\//i.test(text)) return text;
  if (/^data:/i.test(text)) throw new ImageRequestError("Image data URL must use an image MIME type");
  return `data:image/png;base64,${text.replace(/\s+/g, "")}`;
}

async function collectImageValues(value, output, seen = new Set()) {
  if (value === undefined || value === null || value === "") return;
  if (isFileLike(value)) {
    output.push(await fileToDataUrl(value));
    return;
  }
  if (typeof value === "string") {
    const normalized = normalizeStringImage(value);
    if (normalized) output.push(normalized);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) await collectImageValues(item, output, seen);
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  for (const key of ["image_url", "imageUrl", "url", "data_url", "dataUrl"]) {
    if (value[key] !== undefined) {
      await collectImageValues(value[key], output, seen);
      return;
    }
  }
  for (const key of ["b64_json", "base64", "data"]) {
    if (typeof value[key] === "string") {
      const mime = declaredImageMime(value.mime_type || value.mimeType || value.type) || "image/png";
      const data = value[key].replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
      output.push(`data:${mime};base64,${data}`);
      return;
    }
  }
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function parseMultipartScalar(value) {
  return typeof value === "string" ? value : null;
}

function normalizeNumericFields(body) {
  for (const field of ["n", "output_compression"]) {
    if (body[field] === undefined) continue;
    const value = Number(body[field]);
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new ImageRequestError(`${field} must be an integer`);
    }
    if (field === "n" && (value < 1 || value > 10)) {
      throw new ImageRequestError("n must be between 1 and 10");
    }
    if (field === "output_compression" && (value < 0 || value > 100)) {
      throw new ImageRequestError("output_compression must be between 0 and 100");
    }
    body[field] = value;
  }
}

function normalizeStreamField(body) {
  if (typeof body.stream !== "string") return;
  if (body.stream === "true") body.stream = true;
  else if (body.stream === "false") body.stream = false;
}

function normalizeScalarFields(body, formData) {
  for (const field of SCALAR_FIELDS) {
    const value = parseMultipartScalar(formData.get(field));
    if (value !== null && value !== "") body[field] = value;
  }

  normalizeNumericFields(body);
  normalizeStreamField(body);
}

function formImageEntries(formData) {
  const images = [];
  const masks = [];
  for (const [key, value] of formData.entries()) {
    const normalizedKey = String(key).toLowerCase();
    if (IMAGE_FIELD_RE.test(normalizedKey)) images.push(value);
    else if (MASK_FIELD_NAMES.has(normalizedKey)) masks.push(value);
  }
  return { images, masks };
}

/**
 * Parse an OpenAI image request from JSON or multipart/form-data.
 * Files are converted to data URLs once so every provider adapter receives the
 * same canonical representation. The returned body keeps `image` and
 * `images` aliases for existing provider adapters.
 */
export async function parseImageRequest(request, { requireInputImage = false } = {}) {
  const contentType = request.headers.get("content-type") || "";
  const isMultipart = contentType.toLowerCase().includes("multipart/form-data");
  let body;
  let imageValues = [];
  let maskValues = [];

  try {
    if (isMultipart) {
      const formData = await request.formData();
      body = {};
      normalizeScalarFields(body, formData);
      const entries = formImageEntries(formData);
      imageValues = entries.images;
      maskValues = entries.masks;
    } else {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ImageRequestError("Invalid JSON body");
      }
      body = { ...parsed };
      imageValues = [parsed.images, parsed.image, parsed.image_url, parsed.imageUrl];
      maskValues = [parsed.mask, parsed.mask_image, parsed.maskImage, parsed.maskimage];
      normalizeNumericFields(body);
      normalizeStreamField(body);
    }
  } catch (error) {
    if (error instanceof ImageRequestError) throw error;
    throw new ImageRequestError(isMultipart ? "Invalid multipart image request" : "Invalid JSON body");
  }

  const images = [];
  for (const value of imageValues) await collectImageValues(value, images);
  const masks = [];
  for (const value of maskValues) await collectImageValues(value, masks);

  // JSON commonly carries both `images` and the singular `image` alias for
  // the same value; remove that parser-induced duplicate. Multipart fields,
  // however, are intentionally repeatable and identical files still count as
  // separate inputs for providers that support multiple images.
  const uniqueImages = isMultipart ? images : uniqueValues(images);
  const uniqueMasks = uniqueValues(masks);
  delete body.image_url;
  delete body.imageUrl;
  delete body.images;
  delete body.image;
  delete body.mask_image;
  delete body.maskImage;
  delete body.maskimage;
  delete body.mask;

  if (uniqueImages.length > 0) {
    body.images = uniqueImages;
    body.image = uniqueImages[0];
  }
  if (uniqueMasks.length > 0) {
    body.mask = uniqueMasks[0];
    // Keep the aliases for adapters that already understand one of them.
    body.mask_image = uniqueMasks[0];
    body.maskImage = uniqueMasks[0];
    body.maskimage = uniqueMasks[0];
  }
  if (requireInputImage && uniqueImages.length === 0) {
    throw new ImageRequestError("Missing required field: image");
  }
  return body;
}

export function hasImageInput(body) {
  return Array.isArray(body?.images) ? body.images.length > 0 : !!body?.image;
}
