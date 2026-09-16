import { describe, expect, it } from "vitest";
import { formatExactTokens, formatTokens } from "../../src/shared/utils/formatTokens.js";

describe("formatTokens", () => {
  it("keeps small values readable", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatExactTokens(123456)).toBe("123,456");
  });

  it("uses compact units for large token counts", () => {
    expect(formatTokens(1200)).toBe("1.2K");
    expect(formatTokens(12500)).toBe("12.5K");
    expect(formatTokens(1234567)).toBe("1.23M");
    expect(formatTokens(2500000000)).toBe("2.5B");
  });
});

