// Build OpenAI usage object. Caller computes prompt/completion/total (provider math).
// Keep the established cache_creation_tokens spelling for existing consumers;
// Responses serialization translates it to cache_write_tokens where needed.
export function buildUsage({ promptTokens, completionTokens, totalTokens, cachedTokens = 0, cacheCreationTokens = 0, reasoningTokens = 0 }) {
  const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens };
  if (cachedTokens > 0 || cacheCreationTokens > 0) {
    usage.prompt_tokens_details = {};
    if (cachedTokens > 0) usage.prompt_tokens_details.cached_tokens = cachedTokens;
    if (cacheCreationTokens > 0) usage.prompt_tokens_details.cache_creation_tokens = cacheCreationTokens;
  }
  if (reasoningTokens > 0) {
    usage.completion_tokens_details = { reasoning_tokens: reasoningTokens };
  }
  return usage;
}

const numberOrZero = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

// Shared cache-alias readers. Exported so every format translator reads cache
// counters through ONE alias list instead of re-typing a drifting ?? chain per
// file; the list covers OpenAI details, DeepSeek, Claude split and Gemini keys.
export function readCachedTokens(usage = {}) {
  return numberOrZero(
    usage.prompt_tokens_details?.cached_tokens ??
    usage.input_tokens_details?.cached_tokens ??
    usage.cached_tokens ??
    usage.prompt_cache_hit_tokens ??
    usage.cache_read_input_tokens ??
    usage.cachedContentTokenCount,
  );
}

export function readCacheWriteTokens(usage = {}) {
  return numberOrZero(
    usage.prompt_tokens_details?.cache_write_tokens ??
    usage.prompt_tokens_details?.cache_creation_tokens ??
    usage.input_tokens_details?.cache_write_tokens ??
    usage.input_tokens_details?.cache_creation_tokens ??
    usage.cache_write_tokens ??
    usage.cache_creation_input_tokens ??
    usage.cache_write_input_tokens,
  );
}

/**
 * Convert an OpenAI-compatible or canonical usage object to the Responses
 * usage shape. Responses input_tokens is cache-inclusive; cache read/write
 * counts are details, not separate input totals.
 */
export function toResponsesUsage(usage = {}) {
  const baseInputTokens = numberOrZero(usage.input_tokens ?? usage.prompt_tokens);
  const splitCacheRead = numberOrZero(usage.cache_read_input_tokens);
  const splitCacheWrite = numberOrZero(usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens);
  const inputTokens = usage.prompt_tokens === undefined &&
    (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined || usage.cache_write_input_tokens !== undefined)
    ? baseInputTokens + splitCacheRead + splitCacheWrite
    : baseInputTokens;
  const outputTokens = numberOrZero(usage.output_tokens ?? usage.completion_tokens);
  const reasoningTokens = numberOrZero(
    usage.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens,
  );
  const cachedTokens = readCachedTokens(usage);
  const cacheWriteTokens = readCacheWriteTokens(usage);

  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: cachedTokens,
      ...(cacheWriteTokens > 0 ? { cache_write_tokens: cacheWriteTokens } : {}),
    },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: inputTokens + outputTokens,
  };
}

/** Convert provider-native usage to the OpenAI Chat Completions shape. */
export function toOpenAIChatUsage(usage = {}, kind = "openai") {
  if (kind === "claude") {
    return buildUsage(USAGE_EXTRACTORS.claude(usage));
  }
  if (kind === "gemini") {
    return buildUsage(USAGE_EXTRACTORS.gemini(usage));
  }
  const cachedTokens = readCachedTokens(usage);
  const cacheWriteTokens = readCacheWriteTokens(usage);
  const completionTokens = numberOrZero(usage.completion_tokens ?? usage.output_tokens);
  // Split-input shape (Anthropic-style: input_tokens EXCLUDES cache, which rides
  // in bare cache_read/cache_creation counters). Canonical prompt_tokens is
  // cache-INCLUSIVE, so fold the counters in — emitting the exclusive input
  // as-is made clients under-count input and dilute the cache-hit rate.
  const baseInputTokens = numberOrZero(usage.prompt_tokens ?? usage.input_tokens);
  const isSplitInput = usage.prompt_tokens === undefined &&
    (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined || usage.cache_write_input_tokens !== undefined);
  const promptTokens = isSplitInput ? baseInputTokens + cachedTokens + cacheWriteTokens : baseInputTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: numberOrZero(usage.total_tokens) || promptTokens + completionTokens,
    ...((cachedTokens > 0 || cacheWriteTokens > 0) ? {
      prompt_tokens_details: {
        ...(cachedTokens > 0 ? { cached_tokens: cachedTokens } : {}),
        ...(cacheWriteTokens > 0 ? {
          cache_write_tokens: cacheWriteTokens,
          cache_creation_tokens: cacheWriteTokens,
        } : {}),
      },
    } : {}),
    ...(numberOrZero(usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens) > 0 ? {
      completion_tokens_details: { reasoning_tokens: numberOrZero(usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens) },
    } : {}),
  };
}

/** Convert an OpenAI-compatible usage object to Anthropic's split-input shape. */
export function toClaudeUsage(usage = {}) {
  const promptTokens = numberOrZero(usage.prompt_tokens ?? usage.input_tokens);
  const cachedTokens = readCachedTokens(usage);
  const cacheWriteTokens = readCacheWriteTokens(usage);
  // Exclusive-prompt discriminator, mirroring canonicalizeUsage(): bare
  // cache_read/cache_creation counters WITHOUT any inclusive marker (nested
  // details, top-level cached_tokens, prompt_cache_hit_tokens) mean the input
  // total excludes cache (Anthropic style). A bare cache_read next to
  // prompt_tokens alone used to fall into the subtract branch and clamp a real
  // exclusive input to 0 via Math.max.
  const hasInclusiveCacheMarker =
    usage.prompt_tokens_details?.cached_tokens !== undefined ||
    usage.prompt_tokens_details?.cache_write_tokens !== undefined ||
    usage.prompt_tokens_details?.cache_creation_tokens !== undefined ||
    usage.input_tokens_details?.cached_tokens !== undefined ||
    usage.input_tokens_details?.cache_write_tokens !== undefined ||
    usage.input_tokens_details?.cache_creation_tokens !== undefined ||
    usage.cached_tokens !== undefined ||
    usage.prompt_cache_hit_tokens !== undefined;
  const hasSplitInput = !hasInclusiveCacheMarker &&
    (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined || usage.cache_write_input_tokens !== undefined);
  if (hasSplitInput) {
    return {
      input_tokens: numberOrZero(usage.input_tokens ?? usage.prompt_tokens),
      output_tokens: numberOrZero(usage.output_tokens ?? usage.completion_tokens),
      ...(cachedTokens > 0 ? { cache_read_input_tokens: cachedTokens } : {}),
      ...(cacheWriteTokens > 0 ? { cache_creation_input_tokens: cacheWriteTokens } : {}),
    };
  }
  return {
    input_tokens: Math.max(0, promptTokens - cachedTokens - cacheWriteTokens),
    output_tokens: numberOrZero(usage.output_tokens ?? usage.completion_tokens),
    ...(cachedTokens > 0 ? { cache_read_input_tokens: cachedTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cache_creation_input_tokens: cacheWriteTokens } : {}),
  };
}

const n = (v) => (typeof v === "number" ? v : 0);

// Per-provider raw token field-map + math. Returns buildUsage() args (NOT the usage object).
// Keeps each provider's exact semantics: claude/gemini fold cache+reasoning, others don't.
const USAGE_EXTRACTORS = {
  claude(raw) {
    const input = n(raw.input_tokens), output = n(raw.output_tokens);
    const cacheRead = n(raw.cache_read_input_tokens), cacheCreate = n(raw.cache_creation_input_tokens);
    const prompt = input + cacheRead + cacheCreate;
    return { promptTokens: prompt, completionTokens: output, totalTokens: prompt + output, cachedTokens: cacheRead, cacheCreationTokens: cacheCreate };
  },
  gemini(raw) {
    const cached = n(raw.cachedContentTokenCount);
    const prompt = n(raw.promptTokenCount);
    const thoughts = n(raw.thoughtsTokenCount);
    const total = n(raw.totalTokenCount);
    let candidates = n(raw.candidatesTokenCount);
    // Fallback: derive candidates from total when upstream omits it
    if (candidates === 0 && total > 0) {
      candidates = total - prompt - thoughts;
      if (candidates < 0) candidates = 0;
    }
    return { promptTokens: prompt, completionTokens: candidates + thoughts, totalTokens: total || prompt + candidates + thoughts, cachedTokens: cached, reasoningTokens: thoughts };
  },
  kiro(raw) {
    const input = n(raw.inputTokens), output = n(raw.outputTokens);
    // ponytail: Amazon Q (Kiro upstream) does not expose cache fields today,
    // but pass through any cache_read/cache_creation/cached_tokens if the
    // event shape grows them later so cost tracking keeps working without
    // a second pass.
    const cached = n(raw.cache_read_input_tokens) || n(raw.cachedTokens) || n(raw.cached_tokens);
    const cacheCreation = n(raw.cache_creation_input_tokens) || n(raw.cache_write_input_tokens) || n(raw.cache_write_tokens);
    const out = { promptTokens: input, completionTokens: output, totalTokens: input + output };
    if (cached > 0) out.cachedTokens = cached;
    if (cacheCreation > 0) out.cacheCreationTokens = cacheCreation;
    return out;
  },
  ollama(raw) {
    const input = n(raw.prompt_eval_count), output = n(raw.eval_count);
    return { promptTokens: input, completionTokens: output, totalTokens: input + output };
  },
  commandcode(raw) {
    const input = n(raw.inputTokens), output = n(raw.outputTokens);
    const total = typeof raw.totalTokens === "number" ? raw.totalTokens : input + output;
    // CommandCode (AI SDK v5) reports cache reads alongside the cache-inclusive
    // inputTokens: cachedInputTokens / inputTokenDetails.cacheReadTokens, with the
    // gateway's native counters kept under raw.prompt_cache_hit_tokens and
    // raw.prompt_tokens_details.cached_tokens. Dropping them here made every
    // client (DSH, dsh-spend) account a 90%-cached request as an uncached one.
    const cached = n(raw.cachedInputTokens) || n(raw.inputTokenDetails?.cacheReadTokens) ||
      n(raw.raw?.prompt_cache_hit_tokens) || n(raw.raw?.prompt_tokens_details?.cached_tokens) ||
      n(raw.cached_tokens) || n(raw.cache_read_input_tokens);
    const cacheCreation = n(raw.cacheWriteInputTokens) || n(raw.cacheCreationInputTokens) ||
      n(raw.inputTokenDetails?.cacheWriteTokens) || n(raw.inputTokenDetails?.cacheCreationTokens) ||
      n(raw.raw?.cache_write_input_tokens) || n(raw.raw?.prompt_tokens_details?.cache_write_tokens) ||
      n(raw.raw?.prompt_tokens_details?.cache_creation_tokens);
    const out = { promptTokens: input, completionTokens: output, totalTokens: total };
    if (cached > 0) out.cachedTokens = cached;
    if (cacheCreation > 0) out.cacheCreationTokens = cacheCreation;
    return out;
  },
};

// Convert provider-native usage object → OpenAI usage. Returns null if no extractor/raw.
export function toOpenAIUsage(raw, kind) {
  const extract = USAGE_EXTRACTORS[kind];
  if (!extract || !raw || typeof raw !== "object") return null;
  return buildUsage(extract(raw));
}
