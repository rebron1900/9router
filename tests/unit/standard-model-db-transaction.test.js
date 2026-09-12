import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-standard-model-tx-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();
});

afterAll(() => {
  adapter?.close?.();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("standard model provider binding transactions", () => {
  it("rolls back a new binding when mapping validation fails", async () => {
    const model = await db.createStandardModel({ id: "tx-create-model", publicName: "tx-create-model" });

    await expect(db.createStandardModelBindingWithMappings(
      model.id,
      { id: "tx-invalid-binding", providerId: "provider-a" },
      [{ upstreamModelId: "   " }],
    )).rejects.toThrow("upstreamModelId is required");

    expect(await db.getStandardModelBindings(model.id)).toEqual([]);
  });

  it("rolls back binding updates and the previous mappings on an insert constraint", async () => {
    const model = await db.createStandardModel({ id: "tx-update-model", publicName: "tx-update-model" });
    await db.createStandardModelBindingWithMappings(
      model.id,
      { id: "tx-binding", providerId: "provider-before", priority: 2 },
      [{ id: "tx-map-before", upstreamModelId: "upstream-before" }],
    );

    await expect(db.updateStandardModelBindingWithMappings(
      "tx-binding",
      { providerId: "provider-after", priority: 9 },
      [
        { id: "tx-map-duplicate", upstreamModelId: "upstream-after-1" },
        { id: "tx-map-duplicate", upstreamModelId: "upstream-after-2" },
      ],
    )).rejects.toThrow();

    const [binding] = await db.getStandardModelBindings(model.id);
    expect(binding).toMatchObject({ id: "tx-binding", providerId: "provider-before", priority: 2 });
    expect(binding.mappings).toHaveLength(1);
    expect(binding.mappings[0]).toMatchObject({ id: "tx-map-before", upstreamModelId: "upstream-before" });
  });
});
