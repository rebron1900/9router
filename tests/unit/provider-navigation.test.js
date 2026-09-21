import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");
const detailPage = readFileSync(
  resolve(root, "src/app/(dashboard)/dashboard/providers/[id]/page.js"),
  "utf8",
);
const newPage = readFileSync(
  resolve(root, "src/app/(dashboard)/dashboard/providers/new/page.js"),
  "utf8",
);
const providersPath = "/dashboard/model-management?tab=providers";

describe("provider page navigation", () => {
  it("returns provider detail pages to the model-management providers tab", () => {
    expect(detailPage).toContain(`href="${providersPath}"`);
    expect(detailPage).toContain(`router.push("${providersPath}")`);
    expect(detailPage).not.toContain('href="/dashboard/providers"');
  });

  it("returns the new-provider page to the model-management providers tab", () => {
    expect(newPage).toContain(`href="${providersPath}"`);
    expect(newPage).toContain(`router.push("${providersPath}")`);
    expect(newPage).not.toContain('href="/dashboard/providers"');
  });
});
