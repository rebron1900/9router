import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_APIKEY_PROVIDERS,
  USAGE_SUPPORTED_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Command Code registry usage flags", () => {
  it("is listed for the API key quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("commandcode");
    expect(USAGE_APIKEY_PROVIDERS).toContain("commandcode");
  });
});

describe("getUsageForProvider(commandcode)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps credit percentages when preparing rows for the dashboard", () => {
    expect(parseQuotaData("commandcode", {
      quotas: { Credits: { used: 4, total: 15, remainingPercentage: 73.3 } },
    })).toEqual([{
      name: "Credits",
      used: 4,
      total: 15,
      resetAt: null,
      remainingPercentage: 73.3,
      unlimited: undefined,
    }]);
  });

  it("uses internal credits and normalizes credit windows", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ org: { id: "org-1" }, user: { name: "alice" } }))
      .mockResolvedValueOnce(jsonResponse({
        credits: { monthlyCredits: 8, purchasedCredits: 2, freeCredits: 1 },
        windowLimits: {
          fiveHour: { used: 2, cap: 10, resetAt: "2026-09-16T20:00:00Z" },
          weekly: { used: 3, cap: 20, resetAt: "2026-09-20T00:00:00Z" },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ data: { planId: "pro", currentPeriodEnd: "2026-10-01T00:00:00Z" } }))
      .mockResolvedValueOnce(jsonResponse({ totalCost: 4 }));

    const usage = await getUsageForProvider({ provider: "commandcode", apiKey: "user_test" });
    expect(proxyAwareFetch.mock.calls[0][1].headers).toEqual(expect.objectContaining({
      Authorization: "Bearer user_test",
      "x-api-key": "user_test",
    }));
    expect(proxyAwareFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.commandcode.ai/alpha/whoami",
      "https://api.commandcode.ai/internal/billing/credits?orgId=org-1",
      "https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org-1",
      "https://api.commandcode.ai/alpha/usage/summary?orgId=org-1",
    ]);
    expect(usage.plan).toBe("Command Code (pro)");
    expect(usage.quotas.Credits).toMatchObject({
      used: 4,
      total: 15,
      remainingPercentage: (11 / 15) * 100,
    });
    expect(usage.quotas["5h"]).toMatchObject({ used: 2, total: 10, remainingPercentage: 80 });
    expect(usage.quotas.Weekly).toMatchObject({ used: 3, total: 20, remainingPercentage: 85 });
  });

  it("falls back to the alpha credits endpoint", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ org: { id: "org-2" } }))
      .mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404))
      .mockResolvedValueOnce(jsonResponse({ credits: { remainingCredits: 7 } }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}));

    const usage = await getUsageForProvider({ provider: "commandcode", apiKey: "user_test" });
    expect(proxyAwareFetch.mock.calls.map(([url]) => url)).toContain(
      "https://api.commandcode.ai/alpha/billing/credits?orgId=org-2",
    );
    expect(usage.quotas.Credits).toMatchObject({ total: 7, used: 0, remainingPercentage: 100 });
  });

  it("handles missing and rejected credentials", async () => {
    const missing = await getUsageForProvider({ provider: "commandcode" });
    expect(missing.message).toMatch(/api key/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();

    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({}, 401));
    const rejected = await getUsageForProvider({ provider: "commandcode", apiKey: "bad" });
    expect(rejected.message).toMatch(/authentication failed/i);
  });

  it("explains when the account plan has no API access", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({}, 403))
      .mockResolvedValueOnce(jsonResponse({}, 403));
    const usage = await getUsageForProvider({ provider: "commandcode", apiKey: "user_go" });
    expect(usage.message).toMatch(/plan|upgrade|API access/i);
  });
});
