"use client";

import { useEffect, useRef, useState } from "react";
import { Card, Button } from "@/shared/components";

const FALLBACK_MODELS = [
  "cx/gpt-image-2",
  "cx/gpt-image-1.5",
];

function imageDataUrl(item, outputFormat = "png") {
  if (!item) return null;
  if (item.url) return item.url;
  if (item.b64_json) {
    const format = String(outputFormat || "png").toLowerCase() === "jpg" ? "jpeg" : String(outputFormat || "png").toLowerCase();
    return `data:image/${format};base64,${item.b64_json}`;
  }
  return null;
}

export default function ImagesPageClient() {
  const [mode, setMode] = useState("text-to-image");
  const [models, setModels] = useState([]);
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [prompt, setPrompt] = useState("");
  const [sourceFile, setSourceFile] = useState(null);
  const [maskFile, setMaskFile] = useState(null);
  const [sourcePreview, setSourcePreview] = useState("");
  const [maskPreview, setMaskPreview] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [quality, setQuality] = useState("auto");
  const [outputFormat, setOutputFormat] = useState("png");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sourceObjectUrl = useRef("");
  const maskObjectUrl = useRef("");
  const resultObjectUrl = useRef("");

  useEffect(() => {
    let cancelled = false;
    async function loadModels() {
      try {
        const response = await fetch("/api/v1/models/image", { cache: "no-store" });
        const data = response.ok ? await response.json() : { data: [] };
        const discovered = Array.isArray(data.data) ? data.data.map((item) => item?.id).filter(Boolean) : [];
        if (!cancelled) {
          const nextModels = [...new Set(discovered.length ? discovered : FALLBACK_MODELS)];
          setModels(nextModels);
          setModel((current) => current || nextModels[0] || "");
        }
      } catch {
        if (!cancelled) {
          setModels(FALLBACK_MODELS);
          setModel((current) => current || FALLBACK_MODELS[0]);
        }
      }
    }
    loadModels();
    return () => { cancelled = true; };
  }, []);

  // The image endpoints use the same local API-key guard as the other
  // dashboard examples. Keep the secret in memory for the request only; it is
  // never rendered in the page.
  useEffect(() => {
    fetch("/api/keys", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { keys: [] }))
      .then((data) => {
        const activeKey = (data.keys || []).find((item) => item?.isActive !== false)?.key;
        if (activeKey) setApiKey(activeKey);
      })
      .catch(() => {});
  }, []);

  useEffect(() => () => {
    if (sourceObjectUrl.current) URL.revokeObjectURL(sourceObjectUrl.current);
    if (maskObjectUrl.current) URL.revokeObjectURL(maskObjectUrl.current);
    if (resultObjectUrl.current) URL.revokeObjectURL(resultObjectUrl.current);
  }, []);

  const updateFile = (kind, file) => {
    if (kind === "source") {
      if (sourceObjectUrl.current) URL.revokeObjectURL(sourceObjectUrl.current);
      sourceObjectUrl.current = file ? URL.createObjectURL(file) : "";
      setSourceFile(file || null);
      setSourcePreview(sourceObjectUrl.current);
    } else {
      if (maskObjectUrl.current) URL.revokeObjectURL(maskObjectUrl.current);
      maskObjectUrl.current = file ? URL.createObjectURL(file) : "";
      setMaskFile(file || null);
      setMaskPreview(maskObjectUrl.current);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setResultUrl("");
    if (resultObjectUrl.current) {
      URL.revokeObjectURL(resultObjectUrl.current);
      resultObjectUrl.current = "";
    }
    if (!model) return setError("Select an image model first.");
    if (!prompt.trim()) return setError("Describe the image you want to create.");
    if (mode === "image-to-image" && !sourceFile) return setError("Upload a source image to edit.");

    setLoading(true);
    try {
      const endpoint = mode === "image-to-image" ? "/api/v1/images/edits" : "/api/v1/images/generations";
      let body;
      const headers = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      if (mode === "image-to-image") {
        body = new FormData();
        body.append("model", model);
        body.append("prompt", prompt.trim());
        body.append("size", size);
        body.append("quality", quality);
        body.append("output_format", outputFormat);
        body.append("image", sourceFile);
        if (maskFile) body.append("mask", maskFile);
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify({ model, prompt: prompt.trim(), size, quality, output_format: outputFormat, response_format: "b64_json" });
      }
      const response = await fetch(endpoint, { method: "POST", headers, body });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok) {
        let message = `Image request failed (${response.status})`;
        try {
          const data = await response.json();
          message = data?.error?.message || data?.message || message;
        } catch { /* preserve status message */ }
        throw new Error(message);
      }
      let nextUrl = "";
      if (contentType.startsWith("image/")) {
        const blob = await response.blob();
        resultObjectUrl.current = URL.createObjectURL(blob);
        nextUrl = resultObjectUrl.current;
      } else {
        const data = await response.json();
        nextUrl = imageDataUrl(data?.data?.[0], outputFormat);
        if (!nextUrl) throw new Error("The provider returned no image.");
      }
      setResultUrl(nextUrl);
    } catch (requestError) {
      setError(requestError?.message || "Image request failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-text-muted">Create an image from a prompt, or edit an existing image with a reference and optional mask.</p>
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
        <Card className="p-5">
          <div className="mb-5 flex flex-wrap gap-2 rounded-xl bg-surface-2 p-1">
            {[["text-to-image", "Text to Image"], ["image-to-image", "Image to Image"]].map(([value, label]) => (
              <button key={value} type="button" onClick={() => setMode(value)} className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${mode === value ? "bg-surface text-text-main shadow-sm" : "text-text-muted hover:text-text-main"}`}>
                {label}
              </button>
            ))}
          </div>
          <form className="space-y-4" onSubmit={submit}>
            <label className="grid gap-1.5 text-sm text-text-main"><span>Image model</span><select value={model} onChange={(event) => setModel(event.target.value)} className="rounded-lg border border-border bg-background px-3 py-2.5 outline-none focus:border-primary" required><option value="">Select a model</option>{models.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <label className="grid gap-1.5 text-sm text-text-main"><span>Prompt</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} placeholder={mode === "image-to-image" ? "Describe the changes while preserving the parts you want to keep..." : "Describe the image you want to create..."} className="resize-y rounded-lg border border-border bg-background px-3 py-2.5 outline-none focus:border-primary" required /></label>
            {mode === "image-to-image" && <div className="grid gap-4 sm:grid-cols-2"><FilePicker label="Source image" file={sourceFile} preview={sourcePreview} onChange={(file) => updateFile("source", file)} /><FilePicker label="Mask (optional)" file={maskFile} preview={maskPreview} onChange={(file) => updateFile("mask", file)} /></div>}
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="grid gap-1.5 text-sm text-text-main"><span>Size</span><select value={size} onChange={(event) => setSize(event.target.value)} className="rounded-lg border border-border bg-background px-3 py-2.5"><option>1024x1024</option><option>1024x1536</option><option>1536x1024</option><option>1024x1792</option><option>1792x1024</option></select></label>
              <label className="grid gap-1.5 text-sm text-text-main"><span>Quality</span><select value={quality} onChange={(event) => setQuality(event.target.value)} className="rounded-lg border border-border bg-background px-3 py-2.5"><option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
              <label className="grid gap-1.5 text-sm text-text-main"><span>Output format</span><select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value)} className="rounded-lg border border-border bg-background px-3 py-2.5"><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></label>
            </div>
            {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400" role="alert">{error}</div>}
            <Button type="submit" disabled={loading || !model} className="w-full justify-center">{loading ? <><span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>Generating…</> : <><span className="material-symbols-outlined text-[18px]">auto_awesome</span>{mode === "image-to-image" ? "Edit image" : "Generate image"}</>}</Button>
          </form>
        </Card>
        <Card className="flex min-h-[360px] flex-col p-5">
          <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold text-text-main">Result</h2>{resultUrl && <a href={resultUrl} download={`9router-image.${outputFormat === "jpeg" ? "jpg" : outputFormat}`} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-main hover:border-primary hover:text-primary"><span className="material-symbols-outlined text-[16px]">download</span>Download</a>}</div>
          <div className="flex flex-1 items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-surface-2 p-3">{resultUrl ? <img src={resultUrl} alt="Generated result" className="max-h-[520px] max-w-full rounded-lg object-contain" /> : <div className="text-center text-sm text-text-muted"><span className="material-symbols-outlined mb-2 block text-4xl opacity-40">image</span>Your generated image will appear here.</div>}</div>
        </Card>
      </div>
    </div>
  );
}

function FilePicker({ label, file, preview, onChange }) {
  return <label className="grid cursor-pointer gap-1.5 text-sm text-text-main"><span>{label}</span><div className="flex min-h-36 items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-surface-2 p-2 text-center hover:border-primary/60">{preview ? <img src={preview} alt={label} className="max-h-32 max-w-full rounded object-contain" /> : <span className="text-xs text-text-muted"><span className="material-symbols-outlined mb-1 block text-2xl">upload_file</span>{file?.name || "Choose an image"}</span>}<input type="file" accept="image/*" className="sr-only" onChange={(event) => onChange(event.target.files?.[0] || null)} /></div></label>;
}
