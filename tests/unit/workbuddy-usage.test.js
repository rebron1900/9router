import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const account = {
  PackageName: "WorkBuddy Monthly",
  CycleStartTime: "2026-09-01T00:00:00Z",
  CycleEndTime: "2026-10-01T00:00:00Z",
  DeductionEndTime: Date.parse("2026-11-01T00:00:00Z"),
  CycleCapacityUsedPrecise: "2",
  CycleCapacitySizePrecise: "100",
};

describe("WorkBuddy usage request", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends account identity and the verified billing query body", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      code: 0,
      data: { Response: { Data: { Accounts: [account] } } },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const usage = await getUsageForProvider({
      provider: "workbuddy",
      accessToken: "access-token",
      providerSpecificData: {
        uid: "uid-1",
        enterpriseId: "enterprise-1",
        domain: "sso-personal.workbuddy.ai",
      },
    });

    expect(usage.message).toBeUndefined();
    expect(usage.quotas.Monthly).toMatchObject({ used: 2, total: 100, recurring: true });

    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://www.workbuddy.ai/v2/billing/meter/get-user-resource");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-User-Id": "uid-1",
      "X-Domain": "sso-personal.workbuddy.ai",
      "X-Enterprise-Id": "enterprise-1",
      "X-Tenant-Id": "enterprise-1",
      "User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1",
      Origin: "https://www.workbuddy.ai",
      Referer: "https://www.workbuddy.ai/",
    });
    expect(init.headers["X-Enterprise-Id"]).toBe("enterprise-1");
    expect(init.headers["X-Tenant-Id"]).toBe("enterprise-1");

    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: "p_tcaca",
      Status: [0, 3],
    });
    expect(typeof body.PackageEndTimeRangeBegin).toBe("string");
    expect(typeof body.PackageEndTimeRangeEnd).toBe("string");
  });

  it("uses the same recurring/bonus quota semantics in the dashboard", () => {
    const quotas = parseQuotaData("workbuddy", {
      quotas: {
        Monthly: { used: 2, total: 100, resetAt: "2026-10-01T00:00:00.000Z", recurring: true },
        "Bonus Pack 1": { used: 4, total: 10, resetAt: "2026-10-15T00:00:00.000Z", recurring: false },
      },
    });

    expect(quotas).toEqual([
      expect.objectContaining({ name: "Monthly", used: 2, total: 100, recurring: true }),
      expect.objectContaining({ name: "Bonus Pack 1", used: 4, total: 10, recurring: false }),
    ]);
  });
});
