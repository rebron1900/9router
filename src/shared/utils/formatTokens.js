const TOKEN_UNITS = [
  { value: 1e9, suffix: "B" },
  { value: 1e6, suffix: "M" },
  { value: 1e3, suffix: "K" },
];

export function formatExactTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat().format(number);
}

/**
 * Keep token counts compact enough for cards, tables, and inline summaries.
 * The exact value remains available through a title/tooltip at call sites.
 */
export function formatTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";

  const absolute = Math.abs(number);
  const unit = TOKEN_UNITS.find((candidate) => absolute >= candidate.value);
  if (!unit) return formatExactTokens(number);

  const scaled = number / unit.value;
  const precision = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
  return `${Number(scaled.toFixed(precision))}${unit.suffix}`;
}

