import { describe, it, expect } from "vitest";
import { addBufferToUsage, canonicalizeUsage, extractUsage, mergeUsage } from "../../open-sse/utils/usageTracking.js";
import { calculateCostFromTokens } from "../../open-sse/providers/pricing.js";
import { buildUsage, toClaudeUsage, toOpenAIChatUsage, toOpenAIUsage, toResponsesUsage } from "../../open-sse/translator/concerns/usage.js";

// Canonical convention (single source of truth for storage + cost):
//   prompt_tokens             = total input INCLUDING cache read + cache creation
//   cached_tokens             = cache-read portion (subset of prompt_tokens)
//   cache_creation_input_tokens = cache-write portion (subset of prompt_tokens)
//   completion_tokens         = output
// Discriminator: Claude reports cache separately (prompt EXCLUDES cache);
// OpenAI/Gemini report prompt INCLUDING cached_tokens.
describe("canonicalizeUsage", () => {
  it("normalizes native Gemini estimates before persistence", () => {
    const out = canonicalizeUsage({
      promptTokenCount: 1000,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 10,
      totalTokenCount: 1050,
      cachedContentTokenCount: 700,
      estimated: true,
    });
    expect(out).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      cached_tokens: 700,
      cache_creation_input_tokens: 0,
      reasoning_tokens: 10,
    });
  });

  it("folds Claude exclusive cache into an inclusive prompt count", () => {
    // Claude: input_tokens excludes cache; cache_read + cache_creation are separate
    const out = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
    });
    expect(out.prompt_tokens).toBe(330); // 100 + 200 + 30
    expect(out.completion_tokens).toBe(50);
    expect(out.cached_tokens).toBe(200);
    expect(out.cache_creation_input_tokens).toBe(30);
  });

  it("passes through OpenAI inclusive prompt unchanged", () => {
    // OpenAI: prompt_tokens already includes cached_tokens (a subset)
    const out = canonicalizeUsage({
      prompt_tokens: 330,
      completion_tokens: 50,
      cached_tokens: 200,
    });
    expect(out.prompt_tokens).toBe(330);
    expect(out.cached_tokens).toBe(200);
    expect(out.cache_creation_input_tokens).toBe(0);
  });

  it("passes through Gemini inclusive prompt (cachedContent already counted)", () => {
    const out = canonicalizeUsage({
      prompt_tokens: 500,
      completion_tokens: 80,
      cached_tokens: 120,
      reasoning_tokens: 40,
    });
    expect(out.prompt_tokens).toBe(500);
    expect(out.cached_tokens).toBe(120);
    expect(out.reasoning_tokens).toBe(40);
  });

  it("reads cached_tokens from the nested buildUsage() shape", () => {
    // buildUsage() only emits cache reads under prompt_tokens_details. The
    // Responses translator overwrites state.usage with that shape on
    // response.completed, so a top-level-only read silently drops the cache
    // count for every Responses provider (codex, grok-cli, ...).
    const out = canonicalizeUsage(
      buildUsage({ promptTokens: 330, completionTokens: 50, totalTokens: 380, cachedTokens: 200 })
    );
    expect(out.prompt_tokens).toBe(330);
    expect(out.cached_tokens).toBe(200);
  });

  it("handles no-cache usage", () => {
    const out = canonicalizeUsage({ prompt_tokens: 100, completion_tokens: 50 });
    expect(out.prompt_tokens).toBe(100);
    expect(out.cached_tokens).toBe(0);
    expect(out.cache_creation_input_tokens).toBe(0);
  });

  it("is idempotent (running twice yields the same canonical shape)", () => {
    const once = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
    });
    const twice = canonicalizeUsage(once);
    expect(twice.prompt_tokens).toBe(330);
    expect(twice.cached_tokens).toBe(200);
    expect(twice.cache_creation_input_tokens).toBe(30);
    expect(twice.completion_tokens).toBe(50);
  });

  it("does not let a stale top-level cached_tokens:0 mask a nested cache hit", () => {
    // WorkBuddy / CodeBuddy gateways always emit a top-level `cached_tokens: 0`
    // while the real cache-read count sits in prompt_tokens_details (and
    // prompt_cache_hit_tokens). `??` treats 0 as present, so a top-level-first
    // read reports 0 cached tokens on every cache hit — and the dashboard shows
    // a ~0% hit rate for a request the gateway actually billed as cached.
    // Shape captured from a live WorkBuddy response (2026-09-20).
    const out = canonicalizeUsage({
      prompt_tokens: 1994,
      completion_tokens: 59,
      total_tokens: 2053,
      cached_tokens: 0,
      prompt_cache_hit_tokens: 1920,
      prompt_cache_miss_tokens: 74,
      prompt_tokens_details: { cached_tokens: 1920 },
      completion_tokens_details: { cached_tokens: 0, reasoning_tokens: 56 },
    });
    expect(out.cached_tokens).toBe(1920);
    expect(out.prompt_tokens).toBe(1994);
    expect(out.completion_tokens).toBe(59);
    expect(out.reasoning_tokens).toBe(56);
  });

  it("keeps a genuine cache miss at zero when every alias reports 0", () => {
    const out = canonicalizeUsage({
      prompt_tokens: 1994,
      completion_tokens: 59,
      cached_tokens: 0,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 1994,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(out.cached_tokens).toBe(0);
  });

  it("returns null for invalid input", () => {
    expect(canonicalizeUsage(null)).toBeNull();
    expect(canonicalizeUsage(undefined)).toBeNull();
  });

  it("folds a Claude cache-miss first write (cache_creation only, no cache_read yet)", () => {
    // Cache-miss on first write: upstream emits cache_creation_input_tokens but
    // no cache_read_input_tokens at all (not even 0). Must still fold into prompt
    // instead of falling through to the OpenAI passthrough branch.
    const out = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      cache_creation_input_tokens: 500,
    });
    expect(out.prompt_tokens).toBe(600); // 100 + 0 (no read) + 500
    expect(out.cached_tokens).toBe(0);
    expect(out.cache_creation_input_tokens).toBe(500);
  });
});

describe("calculateCostFromTokens (canonical inclusive convention)", () => {
  const pricing = { input: 3, output: 15, cached: 0.3, cache_creation: 3.75 };

  it("prices cached + cache_creation as subsets of an inclusive prompt without double-counting", () => {
    // prompt=330 includes 200 cached + 30 cache_creation → 100 full-price input
    const cost = calculateCostFromTokens(
      { prompt_tokens: 330, completion_tokens: 50, cached_tokens: 200, cache_creation_input_tokens: 30 },
      pricing
    );
    const expected =
      (100 * 3 + 200 * 0.3 + 30 * 3.75 + 50 * 15) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("does not let cache_creation drive nonCached negative", () => {
    // pathological: cached + creation exceeds prompt → nonCached clamps at 0
    const cost = calculateCostFromTokens(
      { prompt_tokens: 100, completion_tokens: 0, cached_tokens: 80, cache_creation_input_tokens: 40 },
      pricing
    );
    const expected = (0 * 3 + 80 * 0.3 + 40 * 3.75) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("matches plain input pricing when no cache present", () => {
    const cost = calculateCostFromTokens({ prompt_tokens: 100, completion_tokens: 50 }, pricing);
    expect(cost).toBeCloseTo((100 * 3 + 50 * 15) / 1_000_000, 12);
  });
});

describe("usage protocol adapters", () => {
  it("does not add headroom to provider-reported usage", () => {
    const out = addBufferToUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    expect(out).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 800 },
    });
  });

  it("adds headroom only to estimated usage", () => {
    const out = addBufferToUsage({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, estimated: true });
    expect(out.prompt_tokens).toBe(3000);
    expect(out.total_tokens).toBe(3050);
  });

  it("serializes canonical cache data to Responses usage", () => {
    expect(toResponsesUsage({
      prompt_tokens: 1000,
      completion_tokens: 80,
      cached_tokens: 700,
      cache_creation_input_tokens: 100,
      reasoning_tokens: 60,
    })).toEqual({
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 },
      output_tokens: 80,
      output_tokens_details: { reasoning_tokens: 60 },
      total_tokens: 1080,
    });
  });

  it("keeps provider-specific cache semantics across Claude and Gemini adapters", () => {
    expect(toClaudeUsage({
      input_tokens: 100,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 100,
      output_tokens: 80,
    })).toEqual({
      input_tokens: 100,
      output_tokens: 80,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 100,
    });

    const gemini = toOpenAIChatUsage({
      promptTokenCount: 1000,
      cachedContentTokenCount: 700,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 60,
      totalTokenCount: 1080,
    }, "gemini");
    expect(gemini).toMatchObject({
      prompt_tokens: 1000,
      completion_tokens: 80,
      total_tokens: 1080,
      prompt_tokens_details: { cached_tokens: 700 },
      completion_tokens_details: { reasoning_tokens: 60 },
    });
  });
});

describe("Anthropic streaming usage (message_start carries cache, message_delta output-only)", () => {
  it("extractUsage reads input + cache from message_start", () => {
    const u = extractUsage({
      type: "message_start",
      message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 } },
    });
    expect(u.prompt_tokens).toBe(100);
    expect(u.cache_read_input_tokens).toBe(200);
    expect(u.cache_creation_input_tokens).toBe(30);
  });

  it("merges message_start cache with message_delta output without clobbering", () => {
    // Real Anthropic SSE: cache only in message_start, real output only in message_delta.
    const start = extractUsage({
      type: "message_start",
      message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 } },
    });
    const delta = extractUsage({ type: "message_delta", usage: { output_tokens: 50 } });
    const merged = mergeUsage(start, delta);
    expect(merged.prompt_tokens).toBe(100);
    expect(merged.cache_read_input_tokens).toBe(200);
    expect(merged.cache_creation_input_tokens).toBe(30);
    expect(merged.completion_tokens).toBe(50);

    // And it canonicalizes to a cache-inclusive prompt for storage/cost.
    const canon = canonicalizeUsage(merged);
    expect(canon.prompt_tokens).toBe(330); // 100 + 200 + 30
    expect(canon.cached_tokens).toBe(200);
    expect(canon.cache_creation_input_tokens).toBe(30);
    expect(canon.completion_tokens).toBe(50);
  });

  it("does not let a NaN field poison the running max-merge", () => {
    // typeof NaN === "number", so a naive Math.max(prev, NaN) is NaN — one
    // malformed chunk must not wipe out an already-accumulated good value.
    const prev = { prompt_tokens: 100, cache_read_input_tokens: 200 };
    const bad = { prompt_tokens: NaN, completion_tokens: 50 };
    const merged = mergeUsage(prev, bad);
    expect(merged.prompt_tokens).toBe(100);
    expect(merged.cache_read_input_tokens).toBe(200);
    expect(merged.completion_tokens).toBe(50);
  });
});

describe("OpenAI-compatible cache aliases", () => {
  it("recognizes split cache-read/write aliases in streaming usage", () => {
    const u = extractUsage({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 40,
        cache_read_input_tokens: 700,
        cache_write_input_tokens: 100,
      },
    });
    expect(u.cached_tokens).toBe(700);
    expect(u.cache_creation_input_tokens).toBe(100);
  });
});

describe("Kiro usage pass-through", () => {
  it("passes through plain input/output when no cache fields are present", () => {
    const out = toOpenAIUsage({ inputTokens: 100, outputTokens: 50 }, "kiro");
    expect(out.prompt_tokens).toBe(100);
    expect(out.completion_tokens).toBe(50);
    expect(out.total_tokens).toBe(150);
    expect(out.prompt_tokens_details).toBeUndefined();
  });

  it("forward-compat: surfaces cache fields if Kiro event shape grows them", () => {
    // ponytail: Amazon Q upstream doesn't expose cache today, but if it starts
    // sending cache_read_input_tokens / cache_creation_input_tokens / cachedTokens,
    // cost tracking should pick them up automatically without another change.
    const out = toOpenAIUsage(
      { inputTokens: 500, outputTokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 },
      "kiro"
    );
    expect(out.prompt_tokens_details).toBeDefined();
    expect(out.prompt_tokens_details.cached_tokens).toBe(200);
    expect(out.prompt_tokens_details.cache_creation_tokens).toBe(50);
  });
});
