"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { translate } from "@/i18n/runtime";

const COLORS = ["#6366f1", "#06b6d4", "#10b981", "#f59e0b", "#f43f5e", "#8b5cf6"];

function formatValue(value, viewMode) {
  if (viewMode === "costs") return `$${Number(value || 0).toFixed(2)}`;
  return new Intl.NumberFormat().format(Math.round(value || 0));
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

function BreakdownCard({ title, dataMap, viewMode, labelFor }) {
  const breakdown = makeSegments(dataMap, viewMode, labelFor);
  const gradient = breakdown.items.length > 0
    ? `conic-gradient(${breakdown.items.map((item) => `${item.color} ${item.start}% ${item.start + item.percentage}%`).join(", ")})`
    : "conic-gradient(#475569 0 100%)";

  return (
    <Card className="min-w-0 overflow-hidden" padding="md">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="font-semibold text-text-main">{translate(title)}</h3>
        <span className="text-xs text-text-muted">{translate(viewMode === "costs" ? "Estimated cost" : "Tokens")}</span>
      </div>
      <div className="grid min-w-0 grid-cols-[minmax(120px,160px)_minmax(0,1fr)] items-center gap-5">
        <div className="relative mx-auto h-36 w-36 rounded-full" style={{ background: gradient }}>
          <div className="absolute inset-[22px] flex flex-col items-center justify-center rounded-full bg-surface text-center">
            <span className="text-lg font-bold text-text-main">{formatValue(breakdown.total, viewMode)}</span>
            <span className="text-[10px] text-text-muted">{translate("Total")}</span>
          </div>
        </div>
        <div className="min-w-0 space-y-2">
          {breakdown.items.length === 0 ? (
            <div className="text-sm text-text-muted">{translate("No data for this period")}</div>
          ) : breakdown.items.map((item) => (
            <div key={item.label} className="flex min-w-0 items-center gap-2 text-xs">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
              <span className="min-w-0 flex-1 truncate text-text-muted" title={item.label}>{item.label}</span>
              <span className="shrink-0 font-mono text-text-main">{item.percentage.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>
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
