import { buildModelsList } from "@/app/api/v1/models/route";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 *
 * Reuses buildModelsList("llm") — the same discovery pipeline /v1/models uses
 * (connections, enabledModels allowlists, connection prefixes, live resolvers,
 * custom models, combos, standard routing and visibility policy) — and converts
 * the OpenAI-format entries to Gemini's models.list shape. Listing the static
 * catalog here instead made Gemini clients see models that routing would
 * reject (and miss live/dynamic ones), with stale prefix and kind info.
 */
export async function GET() {
  try {
    const discovered = await buildModelsList(["llm"]);
    const models = [];
    const seen = new Set();
    for (const entry of discovered) {
      if (!entry?.id || seen.has(entry.id)) continue;
      seen.add(entry.id);
      const displayName = entry.owned_by && !entry.id.startsWith(`${entry.owned_by}/`)
        ? `${entry.owned_by}/${entry.id}`
        : entry.id;
      models.push({
        name: `models/${entry.id}`,
        displayName,
        description: `${entry.owned_by || "router"} model: ${entry.id}`,
        supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
        ...(Number.isFinite(Number(entry.context_length)) ? { inputTokenLimit: Number(entry.context_length) } : { inputTokenLimit: 128000 }),
        ...(Number.isFinite(Number(entry.max_completion_tokens)) ? { outputTokenLimit: Number(entry.max_completion_tokens) } : { outputTokenLimit: 8192 }),
      });
    }

    return Response.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}
