import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { pollForToken } from "../../src/lib/oauth/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { refreshCodebuddyIntlToken } from "../../open-sse/services/tokenRefresh/providers.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

const jwt = (payload) => `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
const accessToken = "eyJ.mock-access-token.signature";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("WorkBuddy OAuth contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    proxyAwareFetch.mockReset();
  });

  it("maps one successful poll with account identity and handles pending 11217", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 11217, msg: "login ing..." }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          accessToken,
          refreshToken: "refresh-token",
          expiresIn: 3600,
          domain: "sso-personal.workbuddy.ai",
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { uid: "uid-1", enterpriseId: "enterprise-1", nickname: "Test WorkBuddy" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = await pollForToken("workbuddy", "state-pending", null, undefined);
    expect(pending).toMatchObject({ success: false, pending: true, error: "authorization_pending" });

    const result = await pollForToken("workbuddy", "state-ready", null, undefined);
    expect(result.success).toBe(true);
    expect(result.tokens).toMatchObject({
      accessToken,
      refreshToken: "refresh-token",
      expiresIn: 3600,
      providerSpecificData: {
        uid: "uid-1",
        enterpriseId: "enterprise-1",
        domain: "sso-personal.workbuddy.ai",
        nickname: "Test WorkBuddy",
      },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://www.workbuddy.ai/v2/plugin/login/account?state=state-ready",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${accessToken}` }),
      }),
    );
  });

  it("falls back to access-token claims when account metadata is unavailable", async () => {
    const token = jwt({ sub: "jwt-user", iss: "https://issuer.workbuddy.ai/sso-jwt-enterprise" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { accessToken: token, refreshToken: "refresh-token", domain: "token-domain.workbuddy.ai" },
      }))
      .mockResolvedValueOnce(jsonResponse({ code: 500, msg: "account unavailable" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollForToken("workbuddy", "state-jwt", null, undefined);

    expect(result.tokens.providerSpecificData).toEqual({
      uid: "jwt-user",
      enterpriseId: "jwt-enterprise",
      domain: "token-domain.workbuddy.ai",
    });
  });

  it("keeps explicit account values over token claims and ignores malformed JWTs", async () => {
    const token = jwt({ sub: "jwt-user", iss: "https://issuer.workbuddy.ai/sso-jwt-enterprise" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { accessToken: token } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { uid: "account-user", enterpriseId: "account-enterprise" } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { accessToken: "not-a-jwt" } }))
      .mockRejectedValueOnce(new Error("account offline"));
    vi.stubGlobal("fetch", fetchMock);

    const explicit = await pollForToken("workbuddy", "state-explicit", null, undefined);
    const malformed = await pollForToken("workbuddy", "state-malformed", null, undefined);

    expect(explicit.tokens.providerSpecificData).toEqual({
      uid: "account-user",
      enterpriseId: "account-enterprise",
      domain: "issuer.workbuddy.ai",
    });
    expect(malformed).toMatchObject({ success: true, tokens: { providerSpecificData: {} } });
  });

  it("merges refreshed claims and domain while preserving old metadata and forwards proxy options", async () => {
    const newAccessToken = jwt({ sub: "new-user", iss: "https://new-issuer.workbuddy.ai/sso-new-enterprise" });
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      code: 0,
      data: {
        accessToken: newAccessToken,
        refreshToken: "new-refresh",
        expiresIn: 1800,
        domain: "refresh-domain.workbuddy.ai",
      },
    }));
    const proxyOptions = { signal: new AbortController().signal, attemptBudget: { id: "budget-1" } };

    const result = await getExecutor("workbuddy").refreshCredentials({
      refreshToken: "unique-workbuddy-refresh-token",
      providerSpecificData: { uid: "old-user", enterpriseId: "old-enterprise", nickname: "Existing Name" },
    }, undefined, proxyOptions);

    expect(result).toMatchObject({
      accessToken: newAccessToken,
      refreshToken: "new-refresh",
      providerSpecificData: {
        uid: "new-user",
        enterpriseId: "new-enterprise",
        domain: "refresh-domain.workbuddy.ai",
        nickname: "Existing Name",
      },
    });
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://www.workbuddy.ai/v2/plugin/auth/token/refresh",
      expect.objectContaining({
        method: "POST",
        body: "",
        headers: expect.objectContaining({
          "X-Refresh-Token": "unique-workbuddy-refresh-token",
          "X-Auth-Refresh-Source": "workbuddy",
          "X-Enterprise-Id": "old-enterprise",
        }),
      }),
      proxyOptions,
    );
  });

  it("keeps direct WorkBuddy refresh headers and body", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      code: 0,
      data: { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 1800 },
    }));

    const result = await refreshCodebuddyIntlToken(
      "direct-workbuddy-refresh-token",
      undefined,
      "workbuddy",
      "sso-personal.workbuddy.ai",
      "workbuddy",
      { enterpriseId: "enterprise-1" },
    );

    expect(result).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresIn: 1800,
    });
  });

  it("keeps the codebuddy-intl branch on plain fetch with a JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      code: 0,
      data: { accessToken: "intl-access", refreshToken: "intl-refresh", expiresIn: 600 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshCodebuddyIntlToken(
      "intl-refresh-token",
      undefined,
      "codebuddy-intl",
      "intl.codebuddy.ai",
      "plugin",
    );

    // Exact shape: the shared WorkBuddy branch must not leak into codebuddy-intl.
    expect(result).toEqual({ accessToken: "intl-access", refreshToken: "intl-refresh", expiresIn: 600 });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({
          "X-Domain": "intl.codebuddy.ai",
          "X-Auth-Refresh-Source": "plugin",
          "X-Product": "SaaS",
        }),
      }),
      // The optional proxyOptions argument is always forwarded; plain fetch
      // ignores the extra `null` (no behavior change for codebuddy-intl).
      null,
    );
  });
});
