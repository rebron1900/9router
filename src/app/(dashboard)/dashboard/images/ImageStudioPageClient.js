"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Button, Card, Input, Select } from "@/shared/components";
import { onLocaleChange, translate } from "@/i18n/runtime";
import { getModelKind, getModelsByProviderId } from "@/shared/constants/models";
import { getProviderAlias, resolveProviderId } from "@/shared/constants/providers";

const DEFAULT_SETTINGS = {
  size: "1024x1024",
  quality: "auto",
  background: "auto",
  outputFormat: "png",
  inputFidelity: "high",
  outputCompression: "",
  count: 1,
};

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,image/heic,image/heif";

function textValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function modelLabel(model) {
  return model?.name || model?.display_name || model?.id || translate("Unknown model");
}

function modelKindLabel(model) {
  return model?.standard_model ? translate("Unified") : (model?.owned_by || translate("Provider"));
}

function previewDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(translate("Unable to preview image")));
    reader.readAsDataURL(file);
  });
}

function outputDataUrl(item, outputFormat) {
  if (!item || typeof item !== "object") return null;
  if (typeof item.b64_json === "string" && item.b64_json) {
    const mime = outputFormat === "jpg" ? "jpeg" : outputFormat;
    return `data:image/${mime};base64,${item.b64_json}`;
  }
  if (typeof item.url === "string" && item.url) return item.url;
  if (typeof item.image_url === "string" && item.image_url) return item.image_url;
  if (typeof item.image === "string" && item.image.startsWith("data:image/")) return item.image;
  return null;
}

function appendOptional(form, key, value, omitted = []) {
  if (value !== undefined && value !== null && value !== "" && !omitted.includes(value)) {
    form.append(key, String(value));
  }
}

function getSafeProviderAlias(providerId) {
  const providerAlias = getProviderAlias(providerId);
  return resolveProviderId(providerAlias) === providerId ? providerAlias : providerId;
}

function getProviderImageModels(providerId) {
  const safeProviderAlias = getSafeProviderAlias(providerId);
  return getModelsByProviderId(providerId)
    .filter((entry) => getModelKind(entry) === "image")
    .map((entry) => ({
      ...entry,
      id: `${safeProviderAlias}/${entry.id}`,
      name: entry.name || entry.id,
      owned_by: providerId,
    }));
}

function RequestResponseSpec({ mode, t }) {
  const isEdit = mode === "edit";
  const requestBodyExample = isEdit
    ? `model=provider/model
prompt=Turn the daytime scene into a sunset
n=1
size=1024x1024
output_format=png
image=@source.png
mask=@mask.png   # optional`
    : `{
  "model": "provider/model",
  "prompt": "A quiet mountain lake at sunrise",
  "n": 1,
  "size": "1024x1024",
  "quality": "auto",
  "background": "auto",
  "output_format": "png",
  "response_format": "b64_json"
}`;
  const responseBodyExample = `{
  "created": 1713833628,
  "data": [
    {
      "b64_json": "<base64 encoded image>"
    }
  ]
}`;
  return (
    <Card title={t("Request & response")} subtitle={t("OpenAI-compatible image contract")} icon="description">
      <div className="grid gap-5 text-sm">
        <div className="grid gap-2">
          <div className="font-medium text-text-main">{t("Request")}</div>
          <code className="rounded-lg bg-bg px-3 py-2 text-xs text-text-main">
            POST {isEdit ? "/v1/images/edits" : "/v1/images/generations"}
          </code>
          <p className="text-xs leading-5 text-text-muted">
            {isEdit
              ? t("Use multipart/form-data with model, prompt, one or more image fields, and an optional mask.")
              : t("Use application/json with model, prompt, and the supported image generation options.")}
          </p>
          <div className="font-medium text-text-main">{t("Request body")}</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-bg px-3 py-2 text-[11px] leading-5 text-text-main"><code>{requestBodyExample}</code></pre>
        </div>
        <div className="grid gap-2">
          <div className="font-medium text-text-main">{t("Response")}</div>
          <code className="rounded-lg bg-bg px-3 py-2 text-xs text-text-main">application/json · image/* · text/event-stream</code>
          <p className="text-xs leading-5 text-text-muted">
            {t("JSON responses contain data items with b64_json or url. Binary responses return image bytes; streaming responses emit progress and completion events.")}
          </p>
          <div className="font-medium text-text-main">{t("Response body")}</div>
          <pre className="overflow-auto whitespace-pre-wrap rounded-lg bg-bg px-3 py-2 text-[11px] leading-5 text-text-main"><code>{responseBodyExample}</code></pre>
          <p className="text-xs leading-5 text-text-muted">
            {t("Use response_format=binary in the query string for raw image bytes, or send Accept: text/event-stream for progress, partial_image, done, and error events.")}
          </p>
        </div>
      </div>
    </Card>
  );
}

RequestResponseSpec.propTypes = {
  mode: PropTypes.oneOf(["generate", "edit"]).isRequired,
  t: PropTypes.func.isRequired,
};

export default function ImageStudioPageClient({ providerId = "", embedded = false }) {
  const [mode, setMode] = useState("generate");
  const [models, setModels] = useState([]);
  const [model, setModel] = useState("");
  const [connections, setConnections] = useState([]);
  const [connectionId, setConnectionId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [prompt, setPrompt] = useState("");
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [sourceFiles, setSourceFiles] = useState([]);
  const [maskFile, setMaskFile] = useState(null);
  const [sourcePreviews, setSourcePreviews] = useState([]);
  const [maskPreview, setMaskPreview] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [, refreshLocale] = useState(0);
  const t = translate;

  useEffect(() => onLocaleChange(() => refreshLocale((value) => value + 1)), [refreshLocale]);

  useEffect(() => {
    let cancelled = false;

    async function loadStudioData() {
      setLoading(true);
      try {
        const [imageModelsResponse, keysResponse, providersResponse] = await Promise.all([
          providerId ? Promise.resolve(null) : fetch("/api/v1/models/image", { cache: "no-store" }),
          fetch("/api/keys", { cache: "no-store" }),
          fetch("/api/providers", { cache: "no-store" }),
        ]);
        const imageModelsData = imageModelsResponse?.ok ? await imageModelsResponse.json() : { data: [] };
        const keysData = keysResponse.ok ? await keysResponse.json() : { keys: [] };
        const providersData = providersResponse.ok ? await providersResponse.json() : { connections: [] };

        let nextModels = providerId
          ? getProviderImageModels(providerId)
          : Array.isArray(imageModelsData.data)
          ? imageModelsData.data.filter((entry) => entry?.id)
          : [];
        if (!providerId && nextModels.length === 0) {
          const fallbackResponse = await fetch("/api/v1/models", { cache: "no-store" });
          const fallbackData = fallbackResponse.ok ? await fallbackResponse.json() : { data: [] };
          nextModels = Array.isArray(fallbackData.data)
            ? fallbackData.data.filter((entry) => entry?.id && (
              entry.standard_model === true || entry.kind === "image" || entry.capabilities?.imageOutput === true
            ))
            : [];
        }

        if (cancelled) return;
        setModels(nextModels);
        setModel((current) => current && nextModels.some((entry) => entry.id === current)
          ? current
          : (nextModels[0]?.id || ""));
        setApiKey(keysData.keys?.find((entry) => entry?.isActive !== false)?.key || "");
        setConnections((providersData.connections || []).filter((entry) => entry?.isActive !== false && (!providerId || entry.provider === providerId)));
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || translate("Unable to load image models"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadStudioData();
    return () => { cancelled = true; };
  }, [providerId]);

  useEffect(() => {
    let cancelled = false;
    if (sourceFiles.length === 0) {
      return undefined;
    }
    Promise.all(sourceFiles.map(async (file) => ({ file, src: await previewDataUrl(file) })))
      .then((previews) => { if (!cancelled) setSourcePreviews(previews); })
      .catch((previewError) => { if (!cancelled) setError(previewError.message || translate("Unable to preview image")); });
    return () => { cancelled = true; };
  }, [sourceFiles]);

  useEffect(() => {
    let cancelled = false;
    if (!maskFile) {
      return undefined;
    }
    previewDataUrl(maskFile)
      .then((preview) => { if (!cancelled) setMaskPreview(preview); })
      .catch((previewError) => { if (!cancelled) setError(previewError.message || translate("Unable to preview image")); });
    return () => { cancelled = true; };
  }, [maskFile]);

  useEffect(() => () => {
    results.forEach((result) => {
      if (result.ownedObjectUrl) URL.revokeObjectURL(result.src);
    });
  }, [results]);

  const modelOptions = models.map((entry) => ({
    value: entry.id,
    label: `${modelLabel(entry)} · ${modelKindLabel(entry)}`,
  }));

  const connectionOptions = [
    { value: "", label: t("Automatic connection selection") },
    ...connections.map((entry) => ({
      value: entry.id,
      label: `${entry.name || entry.provider || t("Connection")} · ${entry.provider || t("Unknown provider")}`,
    })),
  ];
  const allowManualModel = embedded && modelOptions.length === 0;
  const safeProviderAlias = providerId ? getSafeProviderAlias(providerId) : "";
  const requestModel = providerId && allowManualModel && model && !model.includes("/")
    ? `${safeProviderAlias}/${model}`
    : model;

  const updateSetting = (key, value) => setSettings((current) => ({ ...current, [key]: value }));

  const handleSourceChange = (event) => {
    const files = [...(event.target.files || [])].filter((file) => file.type.startsWith("image/")).slice(0, 8);
    setSourceFiles(files);
    if (files.length === 0) setSourcePreviews([]);
    setResults([]);
    setError("");
  };

  const handleMaskChange = (event) => {
    const file = [...(event.target.files || [])].find((candidate) => candidate.type.startsWith("image/")) || null;
    setMaskFile(file);
    if (!file) setMaskPreview("");
    setResults([]);
    setError("");
  };

  const buildRequest = () => {
    const base = {
      model: requestModel,
      prompt: prompt.trim(),
      n: Number(settings.count) || 1,
      size: settings.size,
      response_format: "b64_json",
      output_format: settings.outputFormat,
    };
    if (settings.quality !== "auto") base.quality = settings.quality;
    if (settings.background !== "auto") base.background = settings.background;

    if (mode === "generate") {
      return {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(base),
      };
    }

    const form = new FormData();
    Object.entries(base).forEach(([key, value]) => form.append(key, String(value)));
    appendOptional(form, "input_fidelity", settings.inputFidelity);
    appendOptional(form, "output_compression", settings.outputCompression);
    sourceFiles.forEach((file) => form.append("image", file, file.name));
    if (maskFile) form.append("mask", maskFile, maskFile.name);
    return { headers: {}, body: form };
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setResults([]);
    if (!model) return setError(t("Choose an image-capable model first."));
    if (!prompt.trim()) return setError(t("Enter a prompt before generating."));
    if (mode === "edit" && sourceFiles.length === 0) return setError(t("Choose at least one source image for editing."));

    setGenerating(true);
    try {
      const request = buildRequest();
      const headers = { ...request.headers };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      if (connectionId) headers["x-connection-id"] = connectionId;

      const response = await fetch(`/api/v1/images/${mode === "edit" ? "edits" : "generations"}`, {
        method: "POST",
        headers,
        body: request.body,
      });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok) {
        let errorBody = null;
        try { errorBody = await response.json(); } catch { /* response may be plain text */ }
        throw new Error(errorBody?.error?.message || errorBody?.error || `${t("Image request failed")} (${response.status})`);
      }

      if (contentType.startsWith("image/")) {
        const blob = await response.blob();
        setResults([{ src: URL.createObjectURL(blob), ownedObjectUrl: true, name: "9router-image" }]);
      } else {
        const payload = await response.json();
        const nextResults = (Array.isArray(payload.data) ? payload.data : [])
          .map((item, index) => ({
            src: outputDataUrl(item, settings.outputFormat),
            name: `9router-image-${index + 1}.${settings.outputFormat === "jpeg" ? "jpg" : settings.outputFormat}`,
          }))
          .filter((item) => item.src);
        if (nextResults.length === 0) throw new Error(t("The provider returned no displayable image."));
        setResults(nextResults);
      }
      setNotice(t("Image ready. You can download the result below."));
    } catch (submitError) {
      setError(textValue(submitError.message || submitError));
    } finally {
      setGenerating(false);
    }
  };

  const downloadResult = async (result) => {
    try {
      const response = await fetch(result.src);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.name || "9router-image.png";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      const anchor = document.createElement("a");
      anchor.href = result.src;
      anchor.download = result.name || "9router-image.png";
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      anchor.click();
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {!embedded && <div>
        <h2 className="text-xl font-semibold text-text-main">{t("Image Studio")}</h2>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">{t("Create a new image or transform reference images through the same configured providers and unified model names used by the API.")}</p>
      </div>}

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <Card title={t("Create image")} subtitle={t("Text-to-image and image-to-image")} icon="brush">
          <form className="grid gap-5" onSubmit={handleSubmit}>
            <div className="grid grid-cols-2 gap-2 rounded-[10px] bg-surface-2 p-1">
              {[{ value: "generate", label: t("Text to image"), icon: "auto_awesome" }, { value: "edit", label: t("Edit image"), icon: "edit" }].map((item) => (
                <button
                  type="button"
                  key={item.value}
                  onClick={() => { setMode(item.value); setError(""); setResults([]); }}
                  className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${mode === item.value ? "bg-surface text-text-main shadow-sm" : "text-text-muted hover:text-text-main"}`}
                >
                  <span className="material-symbols-outlined text-[18px]">{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>

            {allowManualModel ? (
              <Input
                label={t("Image model")}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={t("Enter provider model id")}
                required
                hint={t("No registered image models were found for this provider. Enter the upstream model id manually.")}
              />
            ) : (
              <Select
                label={t("Image model")}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                options={modelOptions}
                placeholder={loading ? t("Loading image models...") : t("Choose an image model")}
                disabled={loading || modelOptions.length === 0}
                required
                hint={providerId
                  ? t("Models registered for this provider.")
                  : t("Includes provider-prefixed models and configured provider-neutral standard models.")}
              />
            )}

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-main" htmlFor="image-prompt">{t("Prompt")}<span className="ml-1 text-red-500">*</span></label>
              <textarea
                id="image-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={mode === "edit" ? t("Describe the changes you want to make...") : t("Describe the image you want to create...")}
                rows={5}
                className="w-full resize-y rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 text-[16px] text-text-main placeholder-text-muted/70 outline-none transition focus:border-brand-500/40 focus:ring-2 focus:ring-brand-500/30 sm:text-sm"
              />
            </div>

            {mode === "edit" && (
              <div className="grid gap-4 rounded-[10px] border border-border-subtle bg-bg p-4">
                <div>
                  <div className="text-sm font-medium text-text-main">{t("Source images")}</div>
                  <p className="mt-1 text-xs text-text-muted">{t("Add one or more images. Files are sent as multipart/form-data to the edits endpoint.")}</p>
                </div>
                <label className="flex min-h-28 cursor-pointer items-center justify-center rounded-lg border border-dashed border-border px-4 py-3 text-center text-sm text-text-muted transition hover:border-brand-500/50 hover:bg-surface-2">
                  <input type="file" accept={IMAGE_ACCEPT} multiple className="sr-only" onChange={handleSourceChange} />
                  <span><span className="material-symbols-outlined mb-1 block text-[24px]">upload_file</span>{t("Choose source images")}</span>
                </label>
                {sourcePreviews.length > 0 && <div className="grid grid-cols-4 gap-2">
                  {sourcePreviews.map((preview) => <div key={`${preview.file.name}-${preview.file.lastModified}`} className="relative aspect-square overflow-hidden rounded-lg border border-border-subtle bg-surface-2"><img src={preview.src} alt={preview.file.name} className="size-full object-cover" /><span className="absolute inset-x-1 bottom-1 truncate rounded bg-black/60 px-1 py-0.5 text-[10px] text-white">{preview.file.name}</span></div>)}
                </div>}
                <label className="grid gap-1.5 text-sm text-text-main">
                  <span>{t("Optional mask")}</span>
                  <input type="file" accept={IMAGE_ACCEPT} onChange={handleMaskChange} className="block w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-text-muted file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-2 file:py-1 file:text-xs file:font-medium file:text-primary" />
                </label>
                {maskPreview && <div className="flex items-center gap-3 text-xs text-text-muted"><img src={maskPreview} alt={t("Mask preview")} className="size-12 rounded object-cover" /><span>{maskFile?.name}</span></div>}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Select label={t("Size")} value={settings.size} onChange={(event) => updateSetting("size", event.target.value)} options={[{ value: "1024x1024", label: t("Square · 1024×1024") }, { value: "1024x1536", label: t("Portrait · 1024×1536") }, { value: "1536x1024", label: t("Landscape · 1536×1024") }]} />
              <Select label={t("Quality")} value={settings.quality} onChange={(event) => updateSetting("quality", event.target.value)} options={[{ value: "auto", label: t("Auto") }, { value: "low", label: t("Low") }, { value: "medium", label: t("Medium") }, { value: "high", label: t("High") }]} />
              <Select label={t("Background")} value={settings.background} onChange={(event) => updateSetting("background", event.target.value)} options={[{ value: "auto", label: t("Auto") }, { value: "opaque", label: t("Opaque") }, { value: "transparent", label: t("Transparent") }]} />
              <Select label={t("Output format")} value={settings.outputFormat} onChange={(event) => updateSetting("outputFormat", event.target.value)} options={[{ value: "png", label: t("PNG") }, { value: "jpeg", label: t("JPEG") }, { value: "webp", label: t("WebP") }]} />
              {mode === "edit" && <Select label={t("Input fidelity")} value={settings.inputFidelity} onChange={(event) => updateSetting("inputFidelity", event.target.value)} options={[{ value: "low", label: t("Low") }, { value: "high", label: t("High") }]} />}
              {mode === "edit" && <Select label={t("Compression")} value={settings.outputCompression} onChange={(event) => updateSetting("outputCompression", event.target.value)} options={[{ value: "", label: t("Provider default") }, { value: "50", label: "50%" }, { value: "80", label: "80%" }, { value: "100", label: "100%" }]} />}
              <Input label={t("Number of images")} type="number" min="1" max="10" value={settings.count} onChange={(event) => updateSetting("count", event.target.value)} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Select label={t("Connection")} value={connectionId} onChange={(event) => setConnectionId(event.target.value)} options={connectionOptions} />
              <div className="flex items-end">
                <p className="pb-2 text-xs text-text-muted">{apiKey ? t("A local API key is ready.") : t("No local API key selected; local-mode requests can still work when authentication is disabled.")}</p>
              </div>
            </div>

            {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-600">{error}</div>}
            {notice && <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2.5 text-sm text-green-700">{notice}</div>}
            <Button type="submit" size="lg" icon="auto_awesome" loading={generating} disabled={loading || !model} fullWidth>
              {mode === "edit" ? t("Edit image") : t("Generate image")}
            </Button>
          </form>
        </Card>

        <RequestResponseSpec mode={mode} t={t} />
      </div>

      {results.length > 0 && <Card title={t("Results")} subtitle={`${results.length} ${t(results.length === 1 ? "image returned" : "images returned")}`} icon="photo_library">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {results.map((result, index) => <div key={`${result.src}-${index}`} className="overflow-hidden rounded-xl border border-border-subtle bg-bg">
            <div className="flex min-h-48 items-center justify-center bg-black/5 p-2"><img src={result.src} alt={`${t("Generated result")} ${index + 1}`} className="max-h-[520px] w-full rounded-lg object-contain" /></div>
            <div className="flex items-center justify-between gap-3 border-t border-border-subtle px-3 py-2.5"><span className="truncate text-xs text-text-muted">{result.name}</span><Button type="button" variant="secondary" size="sm" icon="download" onClick={() => downloadResult(result)}>{t("Download")}</Button></div>
          </div>)}
        </div>
      </Card>}
    </div>
  );
}

ImageStudioPageClient.propTypes = {
  providerId: PropTypes.string,
  embedded: PropTypes.bool,
};
