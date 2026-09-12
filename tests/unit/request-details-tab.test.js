// Backend logic behind /dashboard/usage?tab=details.
// Covers crash-risk edge cases in getRequestDetails() used by
// /api/usage/request-details and /api/usage/providers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;
let requestDetailHelpers;

async function saveDetail(detail) {
  await db.saveRequestDetail(detail);
  await new Promise((r) => setTimeout(r, 120));
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-details-tab-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  requestDetailHelpers = await import("../../open-sse/handlers/chatCore/requestDetail.js");
  await db.initDb();
  await db.updateSettings({ enableObservability: true, observabilityBatchSize: 1 });

  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();
});

afterAll(() => {
  adapter?.close?.();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("request details — tab crash-risk cases", () => {
  it("falls back to usage history when observability details are unavailable", async () => {
    adapter.run("DELETE FROM requestDetails");
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [new Date().toISOString(), "openai", "gpt-5.6-luna", "account-1", "/v1/chat/completions", 12, 5, 0.01, "ok", "{}", "{}"]
    );

    const res = await db.getRequestDetails({ provider: "openai", model: "gpt-5.6" });
    expect(res.source).toBe("usageHistory");
    expect(res.details).toHaveLength(1);
    expect(res.details[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      status: "ok",
      source: "usageHistory",
    });
    expect(res.details[0].tokens).toMatchObject({ prompt_tokens: 12, completion_tokens: 5 });

    const successful = await db.getRequestDetails({ provider: "openai", status: "success" });
    expect(successful.details).toHaveLength(1);
  });

  it("merges older request details with newer usage history without duplicating a request", async () => {
    adapter.run("DELETE FROM requestDetails");
    adapter.run("DELETE FROM usageHistory");
    const detailTime = "2030-01-01T00:00:00.000Z";
    const newerTime = "2030-01-01T01:00:00.000Z";
    adapter.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ["merge-detail", detailTime, "merge-provider", "merge-model", "merge-account", "ok", JSON.stringify({
        id: "merge-detail",
        timestamp: detailTime,
        provider: "merge-provider",
        model: "merge-model",
        connectionId: "merge-account",
        status: "ok",
        tokens: { prompt_tokens: 12, completion_tokens: 5 },
        requestId: "merge-request-1",
      })],
    );
    // This is the same request written by both stores; it should be kept only
    // once, with the richer requestDetails representation preferred.
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["2030-01-01T00:00:01.000Z", "merge-provider", "merge-model", "merge-account", "/v1/chat/completions", 12, 5, 0, "ok", "{}", JSON.stringify({ requestId: "merge-request-1" })],
    );
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newerTime, "merge-provider", "merge-model", "merge-account", "/v1/chat/completions", 20, 8, 0, "ok", "{}", "{}"],
    );

    const res = await db.getRequestDetails({ provider: "merge-provider", model: "merge-model", page: 1, pageSize: 20 });
    expect(res.source).toBe("merged");
    expect(res.pagination.totalItems).toBe(2);
    expect(res.details.map((item) => item.source)).toEqual(["usageHistory", "requestDetails"]);
    expect(res.details[0].timestamp).toBe(newerTime);
  });

  it("dedupes production helper writes with the generated correlation ID", async () => {
    adapter.run("DELETE FROM requestDetails");
    adapter.run("DELETE FROM usageHistory");

    const requestId = requestDetailHelpers.createRequestCorrelationId();
    await db.saveRequestDetail(requestDetailHelpers.buildRequestDetail({
      requestId,
      provider: "helper-provider",
      model: "helper-model",
      connectionId: "helper-account",
      tokens: { prompt_tokens: 12, completion_tokens: 5 },
      request: { messages: [] },
      response: { content: "richer detail" },
      status: "success",
    }, { id: "helper-detail" }));

    await requestDetailHelpers.saveUsageStats({
      requestId,
      provider: "helper-provider",
      model: "helper-model",
      connectionId: "helper-account",
      tokens: { prompt_tokens: 12, completion_tokens: 5 },
      endpoint: "/v1/chat/completions",
      silent: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));

    const usageRow = adapter.get("SELECT meta FROM usageHistory WHERE provider = ?", ["helper-provider"]);
    expect(JSON.parse(usageRow.meta)).toMatchObject({ requestId });

    const res = await db.getRequestDetails({ provider: "helper-provider", model: "helper-model" });
    expect(res.pagination.totalItems).toBe(1);
    expect(res.details).toHaveLength(1);
    expect(res.details[0]).toMatchObject({
      id: "helper-detail",
      source: "requestDetails",
      requestId,
      response: { content: "richer detail" },
    });
  });

  it("corrupt data column → parseJson fallback {}, no throw", async () => {
    // Inject a row with invalid JSON directly, bypassing save path
    adapter.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ["corrupt-1", new Date().toISOString(), "openai", "gpt-4", null, "ok", "{not-valid-json"]
    );

    const res = await db.getRequestDetails({ provider: "openai" });
    expect(Array.isArray(res.details)).toBe(true);
    const corrupt = res.details.find((d) => Object.keys(d).length === 0);
    expect(corrupt).toEqual({});
  });

  it("pagination beyond last page → empty details, valid meta", async () => {
    const res = await db.getRequestDetails({ page: 9999, pageSize: 20 });
    expect(res.details).toEqual([]);
    expect(res.pagination.page).toBe(9999);
    expect(res.pagination.hasNext).toBe(false);
    expect(res.pagination.totalItems).toBeGreaterThanOrEqual(0);
  });

  it("does not dedupe two legitimate matching requests without a reliable request key", async () => {
    adapter.run("DELETE FROM requestDetails");
    adapter.run("DELETE FROM usageHistory");
    const first = "2031-01-01T00:00:00.000Z";
    const second = "2031-01-01T00:00:04.000Z";
    for (const timestamp of [first, second]) {
      adapter.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
        [timestamp, "same-provider", "same-model", "same-account", "/v1/chat/completions", 12, 5, 0, "ok", "{}", "{}"],
      );
    }
    const res = await db.getRequestDetails({ provider: "same-provider", pageSize: 20 });
    expect(res.pagination.totalItems).toBe(2);
    expect(res.details).toHaveLength(2);
  });

  it("keeps same-shaped production usage rows with different correlation IDs", async () => {
    adapter.run("DELETE FROM requestDetails");
    adapter.run("DELETE FROM usageHistory");
    const entry = {
      provider: "independent-provider",
      model: "independent-model",
      connectionId: "same-account",
      endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 12, completion_tokens: 5 },
      status: "ok",
    };
    const sameTimestamp = "2033-01-01T00:00:00.000Z";
    await db.saveRequestUsage({ ...entry, requestId: "correlation-a", timestamp: sameTimestamp });
    await db.saveRequestUsage({ ...entry, requestId: "correlation-b", timestamp: sameTimestamp });

    const res = await db.getRequestDetails({ provider: "independent-provider", model: "independent-model", pageSize: 20 });
    expect(res.pagination.totalItems).toBe(2);
    expect(res.details).toHaveLength(2);
  });

  it("pages in SQL and does not read all history rows into JavaScript", async () => {
    adapter.run("DELETE FROM requestDetails");
    adapter.run("DELETE FROM usageHistory");
    for (let i = 0; i < 250; i += 1) {
      adapter.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
        [`2032-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`, "paged-provider", "paged-model", `account-${i}`, "/v1/chat/completions", i + 1, 2, 0, "ok", "{}", "{}"],
      );
    }

    const allSpy = vi.spyOn(adapter, "all");
    try {
      const res = await db.getRequestDetails({ provider: "paged-provider", page: 8, pageSize: 10 });
      expect(res.details).toHaveLength(10);
      expect(res.pagination.totalItems).toBe(250);
      const pageSql = allSpy.mock.calls.map(([sql]) => String(sql)).find((sql) => /LIMIT \?\s+OFFSET \?/i.test(sql));
      expect(pageSql).toBeDefined();
      expect(pageSql).not.toMatch(/SELECT data FROM requestDetails/i);
    } finally {
      allSpy.mockRestore();
    }
  });

  it("invalid startDate → Invalid Date ISO throws inside getRequestDetails is caught upstream", async () => {
    // new Date("bad").toISOString() throws RangeError; verify it surfaces
    // so the API route's try/catch returns 500 rather than silent corruption.
    await expect(db.getRequestDetails({ startDate: "not-a-date" })).rejects.toThrow();
  });

  it("valid date filter range → no throw", async () => {
    const res = await db.getRequestDetails({
      startDate: "2020-01-01T00:00:00",
      endDate: "2999-01-01T00:00:00",
    });
    expect(Array.isArray(res.details)).toBe(true);
  });

  it("large pageSize (providers route uses 9999) → returns all, no crash", async () => {
    await saveDetail({
      id: "big-1", provider: "anthropic", model: "claude-3",
      status: "ok", tokens: { input_tokens: 5 },
      request: { method: "POST" }, response: { content: "hi" },
    });

    const res = await db.getRequestDetails({ pageSize: 9999 });
    expect(res.details.length).toBeGreaterThanOrEqual(1);
    expect(res.pagination.pageSize).toBe(9999);
  });

  it("oversized field → stored truncated + reparseable (no circular)", async () => {
    const huge = "x".repeat(20 * 1024);
    await saveDetail({
      id: "trunc-1", provider: "openai", model: "gpt-4",
      status: "ok", tokens: {},
      request: { blob: huge }, response: { content: "ok" },
    });

    const got = await db.getRequestDetailById("trunc-1");
    expect(got).toBeDefined();
    // Truncated field is a plain object safe for JSON.stringify in the drawer
    expect(() => JSON.stringify(got)).not.toThrow();
    expect(got.request._truncated).toBe(true);
  });

  it("missing tokens/timestamp on row → getInputTokens-style access safe", async () => {
    adapter.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ["sparse-1", new Date().toISOString(), "openai", null, null, null, JSON.stringify({ id: "sparse-1" })]
    );
    const got = await db.getRequestDetailById("sparse-1");
    expect(got.tokens).toBeUndefined();
    // Drawer reads tokens?.prompt_tokens — optional chaining tolerates undefined
    expect(got.tokens?.prompt_tokens || 0).toBe(0);
  });
});

// Mirror of RequestDetailsTab token helpers (component is "use client",
// helpers are not exported). Keep in sync with the component.
function getCachedTokens(tokens) {
  return tokens?.cached_tokens || tokens?.cache_read_input_tokens || 0;
}
function getCacheCreationTokens(tokens) {
  return tokens?.cache_creation_input_tokens || 0;
}
function getInputTokens(tokens) {
  const prompt = tokens?.prompt_tokens || tokens?.input_tokens || 0;
  const cache = getCachedTokens(tokens);
  return prompt < cache ? cache : prompt;
}

describe("backupDbLite — excludes requestDetails, keeps critical data", () => {
  it("backup file omits requestDetails rows but keeps other tables", async () => {
    const { backupDbLite } = await import("@/lib/db/backup.js");
    await saveDetail({ id: "bk-1", provider: "openai", model: "m", status: "ok", tokens: {}, request: {}, response: {} });

    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bklite-"));
    const dest = backupDbLite(adapter, backupDir);
    expect(fs.existsSync(dest)).toBe(true);

    // Open backup and assert requestDetails is empty, settings present
    const Database = (await import("better-sqlite3")).default;
    const bak = new Database(dest);
    try {
      // requestDetails is fully excluded — table must not exist in the backup
      const rdTable = bak.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='requestDetails'").get();
      expect(rdTable).toBeUndefined();
      // Critical data preserved
      const st = bak.prepare("SELECT COUNT(*) c FROM settings").get();
      expect(st.c).toBeGreaterThanOrEqual(1);
    } finally {
      bak.close();
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  });
});

describe("getDistinctProviders — providers route (no full-row parse)", () => {
  it("returns unique provider list without parsing data blobs", async () => {
    await saveDetail({ id: "dp-1", provider: "openai", model: "m", status: "ok", tokens: {}, request: {}, response: {} });
    await saveDetail({ id: "dp-2", provider: "anthropic", model: "m", status: "ok", tokens: {}, request: {}, response: {} });
    await saveDetail({ id: "dp-3", provider: "openai", model: "m", status: "ok", tokens: {}, request: {}, response: {} });

    const list = await db.getDistinctProviders();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toContain("openai");
    expect(list).toContain("anthropic");
    // No duplicates
    expect(new Set(list).size).toBe(list.length);
  });

  it("skips null providers, returns sorted", async () => {
    const list = await db.getDistinctProviders();
    expect(list.every((p) => p !== null)).toBe(true);
    const sorted = [...list].sort();
    expect(list).toEqual(sorted);
  });
});

describe("token helpers — render-time crash safety", () => {
  it("undefined/null tokens → 0, no throw", () => {
    expect(getInputTokens(undefined)).toBe(0);
    expect(getInputTokens(null)).toBe(0);
    expect(getCachedTokens(undefined)).toBe(0);
    expect(getCacheCreationTokens(null)).toBe(0);
  });

  it("empty object → 0 across all helpers", () => {
    expect(getInputTokens({})).toBe(0);
    expect(getCachedTokens({})).toBe(0);
    expect(getCacheCreationTokens({})).toBe(0);
  });

  it("prompt_tokens preferred, falls back to input_tokens", () => {
    expect(getInputTokens({ prompt_tokens: 100 })).toBe(100);
    expect(getInputTokens({ input_tokens: 50 })).toBe(50);
  });

  it("legacy Claude row (prompt < cache) → returns cache", () => {
    expect(getInputTokens({ prompt_tokens: 10, cached_tokens: 200 })).toBe(200);
  });

  it("cached via cache_read_input_tokens alias", () => {
    expect(getCachedTokens({ cache_read_input_tokens: 42 })).toBe(42);
  });

  it("toLocaleString on helper result never throws", () => {
    expect(() => getInputTokens(undefined).toLocaleString()).not.toThrow();
  });
});

describe("API route contract — validation boundary", () => {
  let GET;
  beforeAll(async () => {
    ({ GET } = await import("@/app/api/usage/request-details/route.js"));
  });

  function makeReq(query) {
    return new Request(`http://localhost/api/usage/request-details?${query}`);
  }

  it("page=0 → 400 (guard now reachable after NaN-check fix)", async () => {
    const res = await GET(makeReq("page=0"));
    expect(res.status).toBe(400);
  });

  it("page=-5 → 400", async () => {
    const res = await GET(makeReq("page=-5"));
    expect(res.status).toBe(400);
  });

  it("pageSize=101 → 400", async () => {
    const res = await GET(makeReq("pageSize=101"));
    expect(res.status).toBe(400);
  });

  it("pageSize=abc (NaN) → defaults to 20, returns 200", async () => {
    const res = await GET(makeReq("pageSize=abc"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.pageSize).toBe(20);
  });

  it("invalid startDate → route catches, returns 500 (not thrown)", async () => {
    const res = await GET(makeReq("startDate=not-a-date"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("valid request → 200 with details + pagination shape", async () => {
    const res = await GET(makeReq("page=1&pageSize=20"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.pagination).toMatchObject({ page: 1, pageSize: 20 });
  });
});
