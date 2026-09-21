import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers.js";
import { persistProviderModelCatalog } from "@/lib/modelCatalog.js";

export async function syncCompatibleProviderModelCatalog(connection) {
  const provider = connection?.provider;
  if (!isOpenAICompatibleProvider(provider) && !isAnthropicCompatibleProvider(provider)) {
    return { models: [], skipped: true };
  }

  let baseUrl = String(connection?.providerSpecificData?.baseUrl || "").trim().replace(/\/$/, "");
  if (!baseUrl) return { models: [], skipped: false, error: "No base URL configured" };
  if (isAnthropicCompatibleProvider(provider) && baseUrl.endsWith("/messages")) {
    baseUrl = baseUrl.slice(0, -"/messages".length);
  }

  const headers = isAnthropicCompatibleProvider(provider)
    ? {
      "Content-Type": "application/json",
      "x-api-key": connection.apiKey,
      "anthropic-version": "2023-06-01",
      Authorization: `Bearer ${connection.apiKey}`,
    }
    : {
      "Content-Type": "application/json",
      Authorization: `Bearer ${connection.apiKey}`,
    };

  try {
    const response = await fetch(`${baseUrl}/models`, { method: "GET", headers });
    if (!response.ok) return { models: [], skipped: false, error: `Failed to fetch models: ${response.status}` };
    const data = await response.json();
    const models = Array.isArray(data) ? data : data?.data || data?.models || [];
    await persistProviderModelCatalog(provider, models, {
      providerAlias: connection.providerSpecificData?.prefix,
      markMissingStale: true,
    });
    return { models, skipped: false };
  } catch (error) {
    return { models: [], skipped: false, error: error.message };
  }
}
