/**
 * Command Code usage.
 *
 * Command Code documents the CLI `/usage` command, but does not currently
 * document a public quota API. The CLI/community integrations use the alpha
 * billing endpoints; the internal credits endpoint is tried first because it
 * is the endpoint exposed by the web application.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { parseResetTime, toFiniteNumber } from "./shared.js";

const API_BASE = "https://api.commandcode.ai";
const WHOAMI_URL = `${API_BASE}/alpha/whoami`;
const CREDITS_URLS = [
  `${API_BASE}/internal/billing/credits`,
  `${API_BASE}/alpha/billing/credits`,
];
const SUBSCRIPTIONS_URL = `${API_BASE}/alpha/billing/subscriptions`;
const SUMMARY_URL = `${API_BASE}/alpha/usage/summary`;

function withOrgId(url, orgId) {
  if (!orgId) return url;
  const query = new URLSearchParams({ orgId: String(orgId) });
  return `${url}?${query}`;
}

async function fetchJson(url, apiKey, proxyOptions) {
  const response = await proxyAwareFetch(
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        // Billing endpoints have existed behind both auth middleware stacks;
        // the web/Anthropic path expects x-api-key even when Bearer is valid.
        "x-api-key": apiKey,
        Accept: "application/json",
      },
    },
    proxyOptions,
  );
  const data = await response.json().catch(() => null);
  return { response, data };
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function findObject(root, key) {
  const object = asObject(root);
  if (!object) return null;
  if (asObject(object[key])) return object[key];
  for (const value of Object.values(object)) {
    const nested = findObject(value, key);
    if (nested) return nested;
  }
  return null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function parseCredits(data) {
  const credits = findObject(data, "credits") || asObject(data);
  if (!credits) return null;

  const monthly = toFiniteNumber(firstValue(credits.monthlyCredits, credits.monthly, credits.monthlyBalance), 0);
  const purchased = toFiniteNumber(firstValue(credits.purchasedCredits, credits.purchased, credits.purchasedBalance), 0);
  const free = toFiniteNumber(firstValue(credits.freeCredits, credits.free, credits.freeBalance), 0);
  const explicitRemaining = firstValue(
    credits.remainingCredits,
    credits.remaining,
    credits.balance,
    credits.available,
  );
  const remaining = explicitRemaining === undefined
    ? Math.max(0, monthly + purchased + free)
    : Math.max(0, toFiniteNumber(explicitRemaining, 0));
  const hasCreditFields = [
    "monthlyCredits", "monthly", "monthlyBalance",
    "purchasedCredits", "purchased", "purchasedBalance",
    "freeCredits", "free", "freeBalance",
  ].some((key) => Object.prototype.hasOwnProperty.call(credits, key));
  const hasData = explicitRemaining !== undefined || hasCreditFields;
  if (!hasData) return null;

  return {
    monthly,
    purchased,
    free,
    remaining,
    windowLimits: asObject(data?.windowLimits)
      || asObject(credits.windowLimits)
      || findObject(data, "windowLimits")
      || {},
  };
}

function parseWindow(window, name) {
  if (!window || typeof window !== "object") return null;
  const cap = toFiniteNumber(firstValue(window.cap, window.limit, window.total), 0);
  const used = Math.max(0, toFiniteNumber(firstValue(window.used, window.usage), 0));
  if (cap <= 0 && used <= 0) return null;
  const effectiveCap = Math.max(cap, used);
  return {
    name,
    used,
    total: effectiveCap,
    remainingPercentage: effectiveCap > 0 ? Math.max(0, ((effectiveCap - used) / effectiveCap) * 100) : 0,
    resetAt: parseResetTime(firstValue(window.resetAt, window.resetsAt, window.reset)),
  };
}

function parseAccount(data) {
  const account = asObject(data?.data) || asObject(data);
  const org = asObject(account?.org)
    || asObject(account?.organization)
    || findObject(data, "org")
    || findObject(data, "organization");
  const user = asObject(account?.user) || findObject(data, "user") || {};
  return {
    orgId: firstValue(org?.id, org?.orgId, account?.orgId),
    name: firstValue(user.userName, user.name, user.displayName, org?.login, org?.name),
  };
}

/**
 * @param {string|null|undefined} apiKey
 * @param {object|null} proxyOptions
 */
export async function getCommandCodeUsage(apiKey = null, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "Command Code API key not available. Add a key to view usage." };
  }

  const key = apiKey.trim();
  try {
    // whoami is best-effort: credits may be available without an org query.
    let whoami = { response: { status: 0 }, data: null };
    try {
      whoami = await fetchJson(WHOAMI_URL, key, proxyOptions);
    } catch {
      // The credits endpoint is still useful when whoami is unavailable.
    }
    // `/alpha/whoami` and `/internal/*` may be web-session-only and return
    // 401 even when the API key is valid. Continue with the API-key billing
    // endpoint instead of treating that session response as key rejection.
    const account = parseAccount(whoami.data);
    const orgId = account.orgId;

    let creditsResult = null;
    let sawAuthFailure = false;
    let sawForbidden = false;
    for (const url of CREDITS_URLS) {
      let result;
      try {
        result = await fetchJson(withOrgId(url, orgId), key, proxyOptions);
      } catch {
        continue;
      }
      if (result.response.status === 401 || result.response.status === 403) {
        sawAuthFailure = true;
        if (result.response.status === 403) sawForbidden = true;
        continue;
      }
      if (result.response.ok && parseCredits(result.data)) {
        creditsResult = result;
        break;
      }
    }

    if (!creditsResult) {
      return {
        plan: "Command Code",
        message: sawAuthFailure
          ? sawForbidden
            ? "Command Code usage access is unavailable for this plan. Upgrade to a plan with API access."
            : "Command Code authentication failed. Check the API key."
          : "Command Code credits API returned no recognized quota data.",
      };
    }

    const [subscriptionResult, summaryResult] = await Promise.all([
      fetchJson(withOrgId(SUBSCRIPTIONS_URL, orgId), key, proxyOptions).catch(() => null),
      fetchJson(withOrgId(SUMMARY_URL, orgId), key, proxyOptions).catch(() => null),
    ]);
    const credits = parseCredits(creditsResult.data);
    const summary = asObject(summaryResult?.data);
    const subscription = asObject(subscriptionResult?.data?.data) || asObject(subscriptionResult?.data);
    const used = Math.max(0, toFiniteNumber(firstValue(summary?.totalCost, summary?.cost, summary?.used), 0));
    const total = Math.max(credits.remaining + used, credits.remaining);
    const quotas = {
      Credits: {
        used,
        total,
        remainingPercentage: total > 0 ? (credits.remaining / total) * 100 : 0,
        resetAt: parseResetTime(firstValue(subscription?.currentPeriodEnd, subscription?.periodEnd)),
        unlimited: false,
      },
    };

    const windows = credits.windowLimits;
    const fiveHour = parseWindow(windows.fiveHour || windows.five_hour || windows.session, "5h");
    const weekly = parseWindow(windows.weekly || windows.sevenDay || windows.seven_day, "Weekly");
    if (fiveHour) quotas[fiveHour.name] = fiveHour;
    if (weekly) quotas[weekly.name] = weekly;

    const planId = firstValue(subscription?.planId, subscription?.plan, subscription?.name);
    return {
      plan: planId ? `Command Code (${planId})` : "Command Code",
      quotas,
      account: account.name || undefined,
    };
  } catch (error) {
    return { message: `Command Code error: ${error.message}` };
  }
}
