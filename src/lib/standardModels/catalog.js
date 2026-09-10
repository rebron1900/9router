// The bundled catalog is intentionally conservative. Entries are added only
// after the model publisher's official ID and metadata have been verified.
// Local registrations are persisted separately, so a catalog update cannot
// silently change an existing deployment's routing behavior.
export const BUNDLED_STANDARD_MODEL_CATALOG = {
  schemaVersion: 1,
  catalogVersion: "bundled-2",
  // Keep this list provider-neutral.  A provider-specific prefix belongs in
  // standardModelMappings, never in the public model identity.
  models: [
    {
      publicName: "gpt-5.6-luna",
      officialModelId: "gpt-5.6-luna",
      publisher: "OpenAI",
      displayName: "GPT 5.6 Luna",
      sourceUrl: "https://platform.openai.com/docs/models",
      lifecycle: "active",
      capabilities: { reasoning: true, tools: true, vision: true },
    },
    {
      publicName: "gpt-5.6-terra",
      officialModelId: "gpt-5.6-terra",
      publisher: "OpenAI",
      displayName: "GPT 5.6 Terra",
      sourceUrl: "https://platform.openai.com/docs/models",
      lifecycle: "active",
      capabilities: { reasoning: true, tools: true, vision: true },
    },
    {
      publicName: "gpt-5.6-sol",
      officialModelId: "gpt-5.6-sol",
      publisher: "OpenAI",
      displayName: "GPT 5.6 Sol",
      sourceUrl: "https://platform.openai.com/docs/models",
      lifecycle: "active",
      capabilities: { reasoning: true, tools: true, vision: true },
    },
    {
      publicName: "deepseek-v4-flash",
      officialModelId: "deepseek-v4-flash",
      publisher: "DeepSeek",
      displayName: "DeepSeek V4 Flash",
      sourceUrl: "https://api-docs.deepseek.com/",
      lifecycle: "active",
      capabilities: { reasoning: true, tools: true, vision: true },
    },
    {
      publicName: "glm-5.3-flash",
      officialModelId: "glm-5.3-flash",
      publisher: "智谱 AI",
      displayName: "GLM 5.3 Flash",
      sourceUrl: "https://open.bigmodel.cn/dev/api",
      lifecycle: "active",
      capabilities: { reasoning: true, tools: true, vision: true },
    },
  ],
};

export function getBundledStandardModelCatalog() {
  return structuredClone(BUNDLED_STANDARD_MODEL_CATALOG);
}

export function findBundledStandardModel(publicName) {
  const value = String(publicName || "").trim();
  return BUNDLED_STANDARD_MODEL_CATALOG.models.find((model) => model.publicName === value) || null;
}
