import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";

export type CampaignPackage = {
  id: string;
  version: number;
  plan_hash: string;
  created_at: string;
};

export type PackageItem = {
  item_key: string;
  module_key: string;
  required: boolean;
  external_activation: boolean;
};

export type PackageApproval = {
  id: string;
  action_key: string;
  status: string;
  destination: string;
  requested_at: string;
};

/** The package describes required work; it is not itself evidence that work is ready. */
export function useCampaignV2Package(clientId?: string, campaignId?: string, enabled = false) {
  const [manifest, setManifest] = useState<CampaignPackage | null>(null);
  const [items, setItems] = useState<PackageItem[]>([]);
  const [approvals, setApprovals] = useState<PackageApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || !clientId || !campaignId) return;
    const version = ++request.current;
    setLoading(true);
    setError(null);
    const latest = await supabase.from("campaign_manifest_versions")
      .select("id, version, plan_hash, created_at")
      .eq("client_id", clientId).eq("campaign_id", campaignId)
      .order("version", { ascending: false }).limit(1).maybeSingle();
    if (version !== request.current) return;
    if (latest.error) {
      setError(latest.error.message);
      setManifest(null);
      setItems([]);
      setApprovals([]);
      setLoadedFor(`${clientId}:${campaignId}`);
      setLoading(false);
      return;
    }
    const current = latest.data as CampaignPackage | null;
    setManifest(current);
    if (!current) {
      setItems([]);
      setApprovals([]);
      setLoadedFor(`${clientId}:${campaignId}`);
      setLoading(false);
      return;
    }
    const [itemRows, approvalRows] = await Promise.all([
      supabase.from("campaign_manifest_items")
        .select("item_key, module_key, required, external_activation")
        .eq("manifest_id", current.id),
      supabase.from("campaign_action_approvals")
        .select("id, action_key, status, destination, requested_at")
        .eq("client_id", clientId).eq("campaign_id", campaignId)
        .eq("manifest_id", current.id).order("requested_at", { ascending: false }),
    ]);
    if (version !== request.current) return;
    if (itemRows.error || approvalRows.error) {
      setError(itemRows.error?.message ?? approvalRows.error?.message ?? "Package could not be loaded.");
      setItems([]);
      setApprovals([]);
    } else {
      setItems((itemRows.data ?? []) as PackageItem[]);
      setApprovals((approvalRows.data ?? []) as PackageApproval[]);
    }
    setLoadedFor(`${clientId}:${campaignId}`);
    setLoading(false);
  }, [clientId, campaignId, enabled]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);
  const current = enabled && !loading && loadedFor === `${clientId}:${campaignId}`;
  return {
    manifest: current ? manifest : null,
    items: current ? items : [],
    approvals: current ? approvals : [],
    error: current ? error : null,
    loading: enabled && (loading || !current),
    refresh,
  };
}
