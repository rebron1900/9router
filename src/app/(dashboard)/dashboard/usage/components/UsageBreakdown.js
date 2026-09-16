"use client";

import { useId, useState } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { translate } from "@/i18n/runtime";
import { formatExactTokens, formatTokens } from "@/shared/utils/formatTokens";

const COLORS = ["#6366f1", "#06b6d4", "#10b981", "#f59e0b", "#f43f5e", "#8b5cf6"];

function formatValue(value, viewMode) {
  if (viewMode === "costs") return `$${Number(value || 0).toFixed(2)}`;
  return formatTokens(value);
}

function formatExactValue(value, viewMode) {
  if (viewMode === "costs") return `$${Number(value || 0).toFixed(2)}`;
  return formatExactTokens(value);
}

function getMetric(data, viewMode) {
  if (viewMode === "costs") return Number(data?.cost || 0);
  return Number(data?.promptTokens || 0) + Number(data?.completionTokens || 0);
}

function makeSegments(dataMap, viewMode, labelFor) {
  const entries = Object.entries(dataMap || {})
    .map(([key, data]) => ({ label: labelFor(key, data), value: getMetric(data, viewMode) }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);
  const top = entries.slice(0, 5);
  const other = entries.slice(5).reduce((sum, item) => sum + item.value, 0);
  if (other > 0) top.push({ label: translate("Other"), value: other });
  const total = top.reduce((sum, item) => sum + item.value, 0);
  let cursor = 0;
  return {
    total,
    items: top.map((item, index) => {
      const percentage = total > 0 ? item.value / total * 100 : 0;
      const segment = { ...item, percentage, color: COLORS[index % COLORS.length], start: cursor };
      cursor += percentage;
      return segment;
    }),
  };
}

function polarPoint(angle, radius) {
  const radians = (angle * Math.PI) / 180;
  return [72 + radius * Math.cos(radians), 72 + radius * Math.sin(radians)];
}

function makeDonutPath(item, itemCount, active = false) {
  const outerRadius = active ? 56 : 55;
  const innerRadius = active ? 36 : 37;
  if (itemCount === 1 || item.percentage >= 99.999) {
    const [outerTopX, outerTopY] = polarPoint(-90, outerRadius);
    const [outerBottomX, outerBottomY] = polarPoint(90, outerRadius);
    const [innerTopX, innerTopY] = polarPoint(-90, innerRadius);
    const [innerBottomX, innerBottomY] = polarPoint(90, innerRadius);
    return [
      `M ${outerTopX} ${outerTopY}`,
      `A ${outerRadius} ${outerRadius} 0 1 1 ${outerBottomX} ${outerBottomY}`,
      `A ${outerRadius} ${outerRadius} 0 1 1 ${outerTopX} ${outerTopY}`,
      `M ${innerTopX} ${innerTopY}`,
      `A ${innerRadius} ${innerRadius} 0 1 0 ${innerBottomX} ${innerBottomY}`,
      `A ${innerRadius} ${innerRadius} 0 1 0 ${innerTopX} ${innerTopY}`,
      "Z",
    ].join(" ");
  }
  const gap = itemCount > 1 ? Math.min(1.4, item.percentage * 0.45) : 0;
  const startAngle = -90 + item.start * 3.6 + gap / 2;
  const endAngle = -90 + (item.start + item.percentage) * 3.6 - gap / 2;
  const [outerStartX, outerStartY] = polarPoint(startAngle, outerRadius);
  const [outerEndX, outerEndY] = polarPoint(endAngle, outerRadius);
  const [innerEndX, innerEndY] = polarPoint(endAngle, innerRadius);
  const [innerStartX, innerStartY] = polarPoint(startAngle, innerRadius);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${outerStartX} ${outerStartY}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEndX} ${outerEndY}`,
    `L ${innerEndX} ${innerEndY}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStartX} ${innerStartY}`,
    "Z",
  ].join(" ");
}

function BreakdownCard({ title, dataMap, viewMode, labelFor }) {
  const [activeIndex, setActiveIndex] = useState(null);
  const id = useId().replace(/:/g, "");
  const breakdown = makeSegments(dataMap, viewMode, labelFor);
  const safeActiveIndex = activeIndex !== null && activeIndex < breakdown.items.length ? activeIndex : null;
  const activeItem = safeActiveIndex === null ? null : breakdown.items[safeActiveIndex];
  const gradientPrefix = `usage-donut-${id}`;

  const activate = (index) => setActiveIndex(index);
  const clearActive = () => setActiveIndex(null);

  return (
    <Card className="min-w-0 overflow-visible" padding="sm">
      <div className="flex items-start justify-between gap-3 border-b border-border-subtle pb-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-text-main">{translate(title)}</h3>
          <p className="mt-0.5 text-xs text-text-muted">{translate(viewMode === "costs" ? "Estimated cost" : "Tokens")}</p>
        </div>
        <span className="shrink-0 rounded-full bg-bg-subtle px-2 py-1 text-[11px] font-medium text-text-muted">
          {breakdown.items.length || 0}
        </span>
      </div>

      {breakdown.items.length === 0 ? (
        <div className="flex min-h-[190px] items-center justify-center text-sm text-text-muted">
          {translate("No data for this period")}
        </div>
      ) : (
        <div className="mt-4 grid min-w-0 grid-cols-1 items-start gap-4 sm:grid-cols-[minmax(132px,0.85fr)_minmax(0,1.15fr)] sm:gap-6">
          <div className="relative mx-auto aspect-square w-full max-w-[176px] min-w-[132px] self-start">
            <svg
              viewBox="0 0 144 144"
              className="h-full w-full overflow-visible"
              role="img"
              aria-label={translate(title)}
            >
              <defs>
                {breakdown.items.map((item, index) => (
                  <linearGradient
                    key={`${item.label}-gradient`}
                    id={`${gradientPrefix}-${index}`}
                    x1="0%"
                    y1="0%"
                    x2="100%"
                    y2="100%"
                  >
                    <stop offset="0%" stopColor={item.color} />
                    <stop offset="100%" stopColor={item.color} stopOpacity="0.45" />
                  </linearGradient>
                ))}
              </defs>
              <circle
                cx="72"
                cy="72"
                r="46"
                fill="none"
                stroke="var(--color-border-subtle)"
                strokeWidth="18"
              />
              {breakdown.items.map((item, index) => {
                const isActive = safeActiveIndex === index;
                const midpoint = (-90 + (item.start + item.percentage / 2) * 3.6) * (Math.PI / 180);
                // A 100% segment has no meaningful radial direction, so keep it centered.
                const offset = isActive && breakdown.items.length > 1 && item.percentage < 99.999 ? 4 : 0;
                const offsetX = Math.cos(midpoint) * offset;
                const offsetY = Math.sin(midpoint) * offset;
                return (
                  <path
                    key={item.label}
                    d={makeDonutPath(item, breakdown.items.length, isActive)}
                    fill={`url(#${gradientPrefix}-${index})`}
                    fillRule="evenodd"
                    className="cursor-help"
                    style={{
                      opacity: safeActiveIndex === null || isActive ? 1 : 0.28,
                      transform: `translate(${offsetX}px, ${offsetY}px) scale(${isActive ? 1.025 : 1})`,
                      transformBox: "view-box",
                      transformOrigin: "50% 50%",
                      transition: "transform 220ms ease-out, opacity 220ms ease-out",
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`${item.label}: ${item.percentage.toFixed(1)}%`}
                    onMouseEnter={() => activate(index)}
                    onMouseLeave={clearActive}
                    onFocus={() => activate(index)}
                    onBlur={clearActive}
                    onClick={() => setActiveIndex((current) => (current === index ? null : index))}
                  >
                    <title>{`${item.label}: ${item.percentage.toFixed(1)}% · ${formatExactValue(item.value, viewMode)}`}</title>
                  </path>
                );
              })}
            </svg>
            <div className="pointer-events-none absolute inset-[27%] flex flex-col items-center justify-center rounded-full bg-surface text-center">
              <span
                className="max-w-full truncate px-1 text-base font-bold text-text-main sm:text-lg"
                title={viewMode === "tokens" ? formatExactTokens(breakdown.total) : undefined}
              >
                {formatValue(breakdown.total, viewMode)}
              </span>
              <span className="text-[10px] text-text-muted">{translate("Total")}</span>
            </div>
            {activeItem ? (
              <div
                role="status"
                className="pointer-events-none absolute left-1/2 top-0 z-20 w-max max-w-[220px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-center text-[11px] shadow-lg"
              >
                <div className="truncate font-medium text-text-main" title={activeItem.label}>{activeItem.label}</div>
                <div className="whitespace-nowrap text-text-muted">
                  {activeItem.percentage.toFixed(1)}% · {formatExactValue(activeItem.value, viewMode)}
                </div>
              </div>
            ) : null}
          </div>

          <div className="min-w-0 max-h-[220px] space-y-1 overflow-y-auto rounded-xl border border-border-subtle bg-bg/35 p-1.5 pr-2">
            {breakdown.items.map((item, index) => {
              const isActive = safeActiveIndex === index;
              return (
                <button
                  key={item.label}
                  type="button"
                  className={`group w-full min-w-0 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-200 ${
                    isActive ? "bg-bg-subtle shadow-sm" : "hover:bg-bg-subtle/70"
                  }`}
                  aria-pressed={isActive}
                  onMouseEnter={() => activate(index)}
                  onMouseLeave={clearActive}
                  onFocus={() => activate(index)}
                  onBlur={clearActive}
                  onClick={() => setActiveIndex((current) => (current === index ? null : index))}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white/10"
                      style={{ background: `linear-gradient(135deg, ${item.color}, ${item.color}80)` }}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-main" title={item.label}>
                      {item.label}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-text-muted">{item.percentage.toFixed(1)}%</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-hover">
                      <span
                        className="block h-full rounded-full transition-[width] duration-300"
                        style={{ width: `${Math.max(item.percentage, 2)}%`, background: item.color }}
                      />
                    </span>
                    <span className="shrink-0 text-[10px] text-text-muted" title={formatExactValue(item.value, viewMode)}>
                      {formatValue(item.value, viewMode)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

BreakdownCard.propTypes = {
  title: PropTypes.string.isRequired,
  dataMap: PropTypes.object,
  viewMode: PropTypes.oneOf(["tokens", "costs"]).isRequired,
  labelFor: PropTypes.func.isRequired,
};

export default function UsageBreakdown({ stats, viewMode = "tokens" }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
      <BreakdownCard
        title="Usage by Provider"
        dataMap={stats?.byProvider}
        viewMode={viewMode}
        labelFor={(key) => key}
      />
      <BreakdownCard
        title="Usage by Model"
        dataMap={stats?.byModel}
        viewMode={viewMode}
        labelFor={(key, data) => data?.rawModel || key}
      />
    </div>
  );
}

UsageBreakdown.propTypes = {
  stats: PropTypes.object,
  viewMode: PropTypes.oneOf(["tokens", "costs"]),
};
