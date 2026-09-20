import { describe, expect, it } from "vitest";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";

const credentials = {
  accessToken: "test-token",
  providerSpecificData: {
    uid: "user-1",
    domain: "sso-personal.workbuddy.ai",
  },
};

describe("WorkBuddy provider contract", () => {
  it("registers the verified WorkBuddy endpoints and the full product-config catalog", () => {
    expect(PROVIDERS.workbuddy.baseUrl).toBe("https://www.workbuddy.ai/v2/chat/completions");
    expect(PROVIDERS.workbuddy.usage.url).toBe("https://www.workbuddy.ai/v2/billing/meter/get-user-resource");
    expect(PROVIDER_OAUTH.workbuddy.stateUrl).toBe("https://www.workbuddy.ai/v2/plugin/auth/state");
    // Every id in the CLI product-config payload answered 200 on this gateway.
    expect(PROVIDER_MODELS.wb.map((m) => m.id)).toEqual([
      "default-model", "fast-model", "balanced-model", "primary-model", "deep-model",
      "hy4-preview", "hy3", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
      "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gemini-3.5-flash",
      "glm-5.3", "glm-5.2", "kimi-k3", "kimi-k2.6",
    ]);
  });

  it("declares the live-verified capability set for hy4-preview", () => {
    const capabilities = getCapabilitiesForModel("workbuddy", "hy4-preview");
    // Verified against a connected WorkBuddy account (2026-09-20): image content
    // parts are accepted and grounded, and reasoning_content is emitted on every
    // request and cannot be disabled by any of the four documented switches.
    expect(capabilities.vision).toBe(true);
    expect(capabilities.reasoning).toBe(true);
    expect(capabilities.thinkingCanDisable).toBe(false);
    // Limits from the CLI product-config entry for hy4-preview.
    expect(capabilities.contextWindow).toBe(1000000);
    expect(capabilities.maxOutput).toBe(64000);
    expect(getThinkingLevels("workbuddy", "hy4-preview")).toEqual(["high"]);
  });

  it("maps the product-config flags for the rest of the catalog", () => {
    // No reasoning block in the payload → not a reasoning model.
    expect(getCapabilitiesForModel("workbuddy", "default-model")).toMatchObject({
      vision: true, reasoning: false, contextWindow: 176000, maxOutput: 24000,
    });
    // canDisableThinking: true on the GPT-5.6 family.
    expect(getCapabilitiesForModel("workbuddy", "gpt-5.6-luna")).toMatchObject({
      reasoning: true, thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 128000,
    });
    // canDisableThinking: false on gpt-5.5 / gpt-5.4.
    expect(getCapabilitiesForModel("workbuddy", "gpt-5.5").thinkingCanDisable).toBe(false);
    expect(getCapabilitiesForModel("workbuddy", "gpt-5.4").thinkingCanDisable).toBe(false);
    // published supportedEfforts drive the picker
    expect(getThinkingLevels("workbuddy", "gpt-5.6-sol")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getThinkingLevels("workbuddy", "glm-5.2")).toEqual(["high", "xhigh"]);
    expect(getThinkingLevels("workbuddy", "hy3")).toEqual(["low", "high"]);
    // no published effort set and no reasoning at all
    expect(getThinkingLevels("workbuddy", "default-model")).toBeNull();
  });

  it("keeps image content parts instead of replacing them with a placeholder", () => {
    const body = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what color?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      }],
    };
    const stripped = stripUnsupportedModalities(
      body,
      "openai",
      getCapabilitiesForModel("workbuddy", "hy4-preview"),
    );
    // The helper returns true whenever it ran (audioInput/pdf default to false),
    // so assert on the body: the image block must survive untouched.
    expect(stripped).toBe(true);
    expect(body.messages[0].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    });
  });

  it("forces streaming, supplies a leading system message, and sends account identity", () => {
    const executor = getExecutor("workbuddy");
    const body = executor.transformRequest(
      "hy4-preview",
      {
        messages: [
          { role: "user", content: "hello" },
          { role: "developer", content: "developer rules" },
        ],
        tool_choice: { type: "function", function: { name: "ping" } },
      },
      false,
      credentials,
    );
    const headers = executor.buildHeaders(credentials, true);

    expect(body.stream).toBe(true);
    expect(body.messages[0]).toMatchObject({ role: "system" });
    expect(body.messages[1]).toMatchObject({ role: "user", content: "hello" });
    expect(body.messages[2]).toMatchObject({ role: "system", content: "developer rules" });
    expect(body.tool_choice).toBe("ping");
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["X-User-Id"]).toBe("user-1");
    expect(headers["X-Domain"]).toBe("sso-personal.workbuddy.ai");
    expect(headers["X-No-Enterprise-Id"]).toBe("1");
    expect(headers.Origin).toBe("https://www.workbuddy.ai");
    expect(headers.Referer).toBe("https://www.workbuddy.ai/");
    expect(headers["X-Request-ID"]).toMatch(/^[0-9a-f]{32}$/);
    expect(headers["X-Request-Trace-Id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
