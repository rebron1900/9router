"use client";

// Suspense boundary is REQUIRED around useSearchParams() — Next 16 static
// prerendering bails out of CSR at build time without one
// (missing-suspense-with-csr-bailout), which fails `next build`.
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ProvidersPage from "../providers/page";
import CombosPage from "../combos/page";
import StandardModelsPage from "../standard-models/page";
import ModelControlModal from "../providers/components/ModelControlModal";
import { CardSkeleton, SegmentedControl } from "@/shared/components";
import { onLocaleChange, translate } from "@/i18n/runtime";

const TABS = [
  { key: "providers", label: "Providers", icon: "dns" },
  { key: "combos", label: "Combo & Vision Adapter", icon: "layers" },
  { key: "standard", label: "Standard Model Routing", icon: "hub" },
  { key: "visibility", label: "Model Visibility", icon: "visibility" },
];

function normalizeTab(value) {
  return TABS.some((tab) => tab.key === value) ? value : "providers";
}

export default function ModelManagementPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <ModelManagementContent />
    </Suspense>
  );
}

function ModelManagementContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const [localTab, setLocalTab] = useState("providers");
  const [, refreshLocale] = useState(0);
  const [connections, setConnections] = useState([]);
  const [providerNodes, setProviderNodes] = useState([]);
  const activeTab = normalizeTab(requestedTab || localTab);

  useEffect(() => onLocaleChange(() => refreshLocale((value) => value + 1)), [refreshLocale]);

  useEffect(() => {
    if (activeTab !== "visibility") return undefined;

    let cancelled = false;
    Promise.all([
      fetch("/api/providers", { cache: "no-store" }),
      fetch("/api/provider-nodes", { cache: "no-store" }),
    ])
      .then(async ([providersResponse, nodesResponse]) => {
        const providersData = providersResponse.ok ? await providersResponse.json() : {};
        const nodesData = nodesResponse.ok ? await nodesResponse.json() : {};
        if (cancelled) return;
        setConnections(Array.isArray(providersData.connections) ? providersData.connections : []);
        setProviderNodes(Array.isArray(nodesData.nodes) ? nodesData.nodes : []);
      })
      .catch(() => {
        if (!cancelled) {
          setConnections([]);
          setProviderNodes([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  const selectTab = (tab) => {
    setLocalTab(tab);
    router.replace(`/dashboard/model-management?tab=${tab}`, { scroll: false });
  };

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-start">
        <SegmentedControl
          options={TABS.map((tab) => ({
            value: tab.key,
            label: translate(tab.label),
            icon: tab.icon,
          }))}
          value={activeTab}
          onChange={selectTab}
          className="w-full sm:w-auto"
        />
      </div>

      {activeTab === "providers" && <ProvidersPage />}
      {activeTab === "combos" && <CombosPage />}
      {activeTab === "standard" && <StandardModelsPage />}
      {activeTab === "visibility" && (
        <ModelControlModal
          embedded
          isOpen
          onClose={() => {}}
          connections={connections}
          providerNodes={providerNodes}
        />
      )}
    </div>
  );
}
