"use client";

import { useEffect, useState } from "react";
import ModelControlModal from "../providers/components/ModelControlModal";

export default function ModelVisibilityPage() {
  const [connections, setConnections] = useState([]);
  const [providerNodes, setProviderNodes] = useState([]);

  useEffect(() => {
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
  }, []);

  return (
    <div className="min-w-0 px-1 sm:px-0">
      <ModelControlModal
        embedded
        isOpen
        onClose={() => {}}
        connections={connections}
        providerNodes={providerNodes}
      />
    </div>
  );
}

