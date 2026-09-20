import { WORKBUDDY_CONFIG } from "../constants/oauth.js";
import { getWorkBuddyIdentity } from "open-sse/shared/workbuddyAuth.js";

const DOMAIN = "www.workbuddy.ai";
const baseHeaders = (config) => ({
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": config.userAgent,
  "X-Requested-With": "XMLHttpRequest",
  Origin: config.baseUrl,
  Referer: `${config.baseUrl}/`,
});

const workbuddy = {
  config: WORKBUDDY_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const response = await fetch(`${config.stateUrl}?platform=${config.platform}`, {
      method: "POST",
      headers: {
        ...baseHeaders(config),
        "X-Domain": DOMAIN,
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
      },
      body: "{}",
    });
    if (!response.ok) throw new Error(`WorkBuddy state request failed: ${await response.text()}`);
    const json = await response.json();
    if (json.code !== 0 || !json.data?.state || !json.data?.authUrl) {
      throw new Error(`WorkBuddy state error: ${json.msg || "missing state/authUrl"}`);
    }
    return {
      device_code: json.data.state,
      verification_uri: json.data.authUrl,
      user_code: "",
      interval: config.pollInterval / 1000,
      _isCodeBuddy: true,
    };
  },
  pollToken: async (config, state) => {
    const response = await fetch(`${config.tokenUrl}?state=${encodeURIComponent(state)}`, {
      headers: baseHeaders(config),
    });
    if (!response.ok) return { ok: false, data: { error: "request_failed" } };
    const json = await response.json();
    if (json.code === 11217) return { ok: true, data: { error: "authorization_pending" } };
    if (json.code !== 0 || !json.data?.accessToken) {
      return { ok: false, data: { error: json.msg || "unknown_error" } };
    }

    let account = {};
    try {
      const accountResponse = await fetch(`${config.accountUrl}?state=${encodeURIComponent(state)}`, {
        headers: { ...baseHeaders(config), Authorization: `Bearer ${json.data.accessToken}` },
      });
      const accountJson = accountResponse.ok ? await accountResponse.json() : null;
      if (accountJson?.code === 0) account = accountJson.data || {};
    } catch {
      // Account metadata is optional; token fields remain usable fallbacks.
    }

    return {
      ok: true,
      data: {
        access_token: json.data.accessToken,
        refresh_token: json.data.refreshToken || "",
        token_type: json.data.tokenType || "Bearer",
        expires_in: json.data.expiresIn,
        _workbuddy: getWorkBuddyIdentity(json.data.accessToken, {
          uid: account.uid,
          enterpriseId: account.enterpriseId,
          nickname: account.nickname,
          domain: json.data.domain || account.domain,
        }),
      },
    };
  },
  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in || 86400,
    providerSpecificData: {
      ...(tokens._workbuddy?.uid ? { uid: String(tokens._workbuddy.uid) } : {}),
      ...(tokens._workbuddy?.enterpriseId ? { enterpriseId: String(tokens._workbuddy.enterpriseId) } : {}),
      ...(tokens._workbuddy?.domain ? { domain: String(tokens._workbuddy.domain) } : {}),
      ...(tokens._workbuddy?.nickname ? { nickname: String(tokens._workbuddy.nickname) } : {}),
    },
  }),
};

export default workbuddy;
