"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { UsageStats, RequestLogger, Card, CardSkeleton, SegmentedControl, Button } from "@/shared/components";
import { translate } from "@/i18n/runtime";
import RequestDetailsTab from "./components/RequestDetailsTab";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
  { value: "all", label: "All" },
];

const TABS = [
  { value: "overview", label: "Overview", icon: "dashboard" },
  { value: "logs", label: "Request Logs", icon: "receipt_long" },
  { value: "details", label: "Details", icon: "manage_search" },
];

export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [period, setPeriod] = useState("today");

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && ["overview", "logs", "details"].includes(tabFromUrl)
    ? tabFromUrl
    : "overview";

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };

  const activeTabMeta = TABS.find((tab) => tab.value === activeTab) || TABS[0];
  const activePeriodLabel = PERIODS.find((item) => item.value === period)?.label || period;
  const contextLabel = activeTab === "overview"
    ? `${translate(activePeriodLabel)} · ${translate("Live")}`
    : translate(activeTab === "logs" ? "Request Logs" : "Request Details");

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      {/* Page header */}
      <div className="relative overflow-hidden rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/[0.12] via-surface to-surface px-5 py-5 shadow-[var(--shadow-soft)] sm:px-6 sm:py-6">
        <div className="pointer-events-none absolute -right-12 -top-16 size-44 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-white shadow-sm">
              <span className="material-symbols-outlined text-[23px]">monitoring</span>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">{translate("Usage")}</p>
              <h1 className="mt-1 truncate text-2xl font-bold tracking-tight text-text-main sm:text-3xl">{translate("Usage & Analytics")}</h1>
              <p className="mt-1 max-w-2xl text-sm text-text-muted">{translate("Monitor your API usage, token consumption, and request logs")}</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-3 text-xs font-medium text-success">
              <span className="size-1.5 animate-pulse rounded-full bg-success" />
              {translate("Live")}
            </span>
            <Button
              size="sm"
              variant="secondary"
              icon="refresh"
              onClick={() => window.location.reload()}
              title={translate("Refresh")}
            >
              <span className="hidden sm:inline">{translate("Refresh")}</span>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="speed"
              onClick={() => router.push("/dashboard/quota")}
            >
              {translate("Quota Tracker")}
            </Button>
          </div>
        </div>
      </div>

      {/* Navigation and period toolbar */}
      <Card padding="xs" className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          options={TABS.map((tab) => ({ ...tab, label: translate(tab.label) }))}
          value={activeTab}
          onChange={handleTabChange}
          className="w-full sm:w-auto"
        />
        {activeTab === "overview" && (
          <SegmentedControl
            options={PERIODS.map((item) => ({ ...item, label: translate(item.label) }))}
            value={period}
            onChange={setPeriod}
            size="sm"
            className="w-full sm:w-auto"
          />
        )}
      </Card>

      <div className="flex min-w-0 items-center gap-2 px-1 text-xs text-text-muted">
        <span className="material-symbols-outlined text-[16px] text-primary">{activeTabMeta.icon}</span>
        <span className="font-medium text-text-main">{translate(activeTabMeta.label)}</span>
        <span className="text-border">•</span>
        <span>{contextLabel}</span>
      </div>

      {activeTab === "overview" && (
        <Suspense fallback={<CardSkeleton />}>
          <UsageStats period={period} setPeriod={setPeriod} hidePeriodSelector />
        </Suspense>
      )}
      {activeTab === "logs" && <RequestLogger />}
      {activeTab === "details" && <RequestDetailsTab />}
    </div>
  );
}
