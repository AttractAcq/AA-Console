import { useCallback, useEffect, useState } from "react";

import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Bundle = Database["public"]["Tables"]["paid_operator_bundles_v7"]["Row"];
type Event = Database["public"]["Tables"]["paid_operator_events_v7"]["Row"];
type Package = Pick<Database["public"]["Tables"]["campaign_preparation_packages_v7"]["Row"],
  "id" | "campaign_id" | "version" | "assembled_at">;
type Campaign = Pick<Database["public"]["Tables"]["client_campaigns"]["Row"],
  "id" | "name" | "paid_platform">;
type MetricMatch = { bundle_id: string; match_state: string; external_campaign_id: string | null;
  latest_metric_date: string | null; latest_fetched_at: string | null; days_with_rows: number;
  recorded_spend: number | null; recorded_impressions: number | null;
  recorded_clicks: number | null; recorded_conversions: number | null;
  currency: string | null; currencies_seen: number };

function sourceOf(bundle: Bundle): Record<string, unknown> {
  const snapshot = bundle.snapshot;
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    && snapshot.source && typeof snapshot.source === "object" && !Array.isArray(snapshot.source)
    ? snapshot.source as Record<string, unknown> : {};
}

type CreativeFile = { asset_id: string; storage_path: string; file_sha256: string; title?: string };

function creativeFiles(bundle: Bundle): CreativeFile[] {
  const creative = sourceOf(bundle).creative;
  if (!Array.isArray(creative)) return [];
  return creative.filter((item): item is CreativeFile => !!item && typeof item === "object"
    && typeof item.asset_id === "string" && typeof item.storage_path === "string"
    && typeof item.file_sha256 === "string");
}

async function downloadCreative(file: CreativeFile): Promise<void> {
  const { data, error } = await supabase.storage.from("client-media").download(file.storage_path);
  if (error || !data) throw new Error(error?.message ?? "Creative file unavailable.");
  const bytes = await data.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== file.file_sha256) throw new Error("Creative file differs from the reviewed bundle.");
  const url = URL.createObjectURL(new Blob([bytes], { type: data.type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.storage_path.split("/").at(-1) || `creative-${file.asset_id}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function PaidOperatorBundles({ clientId, platform }: {
  clientId: string | undefined; platform: "meta" | "google";
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [packages, setPackages] = useState<Package[]>([]);
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [current, setCurrent] = useState<Record<string, boolean>>({});
  const [matches, setMatches] = useState<Record<string, MetricMatch>>({});
  const [packageId, setPackageId] = useState("");
  const [owner, setOwner] = useState("");
  const [budget, setBudget] = useState("");
  const [tracking, setTracking] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    try {
      const [c, p, b, e, m] = await Promise.all([
        supabase.from("client_campaigns").select("id,name,paid_platform")
          .eq("client_id", clientId).eq("runs_paid", true).eq("paid_platform", platform),
        supabase.from("campaign_preparation_packages_v7")
          .select("id,campaign_id,version,assembled_at")
          .eq("client_id", clientId).order("assembled_at", { ascending: false }).limit(100),
        supabase.from("paid_operator_bundles_v7").select("*")
          .eq("client_id", clientId).eq("platform", platform)
          .order("created_at", { ascending: false }).limit(50),
        supabase.from("paid_operator_events_v7").select("*")
          .eq("client_id", clientId).order("recorded_at", { ascending: false }).limit(100),
        supabase.from("paid_operator_metric_match_v7").select("*")
          .eq("client_id", clientId).eq("platform", platform).limit(50),
      ]);
      for (const result of [c, p, b, e, m]) if (result.error) throw result.error;
      const campaigns = (c.data ?? []) as Campaign[];
      const campaignIds = new Set(campaigns.map((item) => item.id));
      const latest = new Map<string, Package>();
      for (const row of (p.data ?? []) as Package[]) {
        if (campaignIds.has(row.campaign_id) && !latest.has(row.campaign_id)) latest.set(row.campaign_id, row);
      }
      const visibleBundles = (b.data ?? []) as Bundle[];
      const checks = await Promise.all(visibleBundles.map(async (row) => {
        const result = await supabase.rpc("paid_operator_bundle_current_v7", { p_bundle_id: row.id });
        return [row.id, !result.error && result.data === true] as const;
      }));
      setCampaigns(campaigns);
      setPackages([...latest.values()]);
      setBundles(visibleBundles);
      setEvents(((e.data ?? []) as Event[]).filter((row) =>
        visibleBundles.some((bundle) => bundle.id === row.bundle_id)));
      setCurrent(Object.fromEntries(checks));
      setMatches(Object.fromEntries(((m.data ?? []) as MetricMatch[])
        .map((row) => [row.bundle_id, row])));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load operator bundles.");
    }
  }, [clientId, platform]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    if (!packageId || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await supabase.rpc("create_paid_operator_bundle_v7", {
        p_package_id: packageId, p_owner: owner, p_budget_instruction: budget,
        p_tracking_instruction: tracking,
      });
      if (result.error) throw result.error;
      setNotice(`Exact ${platform === "meta" ? "Meta" : "Google"} operator bundle frozen. Review and download it before reporting handoff.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not freeze the paid bundle.");
    } finally { setBusy(false); }
  };

  const record = async (bundle: Bundle, kind: "handoff_reported" | "external_ids_reported") => {
    if (busy) return;
    const reference = window.prompt(kind === "handoff_reported"
      ? "What ticket or message reference records the handoff to this operator?"
      : "What Ads Manager URL or ticket supports these external IDs?")?.trim();
    if (!reference) return;
    const campaignId = kind === "external_ids_reported"
      ? window.prompt("External campaign ID as shown in the ad account")?.trim() : undefined;
    if (kind === "external_ids_reported" && !campaignId) return;
    const adId = kind === "external_ids_reported"
      ? window.prompt("External ad ID, if known")?.trim() : undefined;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await supabase.rpc("record_paid_operator_event_v7", {
        p_bundle_id: bundle.id, p_event: kind, p_reference: reference,
        p_external_campaign_id: campaignId || undefined, p_external_ad_id: adId || undefined,
      });
      if (result.error) throw result.error;
      setNotice(kind === "handoff_reported" ? "Operator handoff reported. This is not an observed account action."
        : "External IDs reported. Reconcile them against the provider account and metrics before treating them as verified.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record operator event.");
    } finally { setBusy(false); }
  };

  const download = (bundle: Bundle) => {
    const blob = new Blob([JSON.stringify({ id: bundle.id, version: bundle.version,
      sha256: bundle.snapshot_hash, snapshot: bundle.snapshot }, null, 2)],
    { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `${platform}-operator-bundle-v${bundle.version}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const verifyDownload = async (bundle: Bundle) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const files = creativeFiles(bundle);
      if (files.length === 0) throw new Error("The exact bundle has no downloadable creative files.");
      download(bundle);
      for (const file of files) await downloadCreative(file);
      const result = await supabase.rpc("record_paid_operator_event_v7", {
        p_bundle_id: bundle.id, p_event: "verified_download",
        p_reference: `browser-sha256:${bundle.snapshot_hash}`,
      });
      if (result.error) throw result.error;
      setNotice("Bundle and creative bytes verified and downloaded. This is a browser report, not an external handoff receipt.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not verify the bundle files.");
    } finally { setBusy(false); }
  };

  return <section className="space-y-4 rounded-lg border border-border bg-card p-4" aria-label={`${platform} paid operator bundles`}>
    <div>
      <h3 className="font-semibold">Human paid operator bundles</h3>
      <p className="text-xs text-muted-foreground">A current approved campaign preparation package and exact creative signoff are required. Handoff and external IDs are operator reports; no ad is built or activated here.</p>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="text-xs">Reviewed campaign package
        <select className="mt-1 w-full rounded border border-border bg-background p-2" value={packageId}
          onChange={(event) => setPackageId(event.target.value)}>
          <option value="">Select package</option>
          {packages.map((item) => <option key={item.id} value={item.id}>
            {campaigns.find((campaign) => campaign.id === item.campaign_id)?.name ?? "Campaign"} · v{item.version}
          </option>)}
        </select>
      </label>
      <label className="text-xs">Paid operator
        <input className="mt-1 w-full rounded border border-border bg-background p-2" value={owner}
          onChange={(event) => setOwner(event.target.value)} placeholder="Name or team" />
      </label>
      <label className="text-xs">Budget instruction
        <textarea className="mt-1 w-full rounded border border-border bg-background p-2" value={budget}
          onChange={(event) => setBudget(event.target.value)} placeholder="Daily cap and who may change it" />
      </label>
      <label className="text-xs">Tracking instruction
        <textarea className="mt-1 w-full rounded border border-border bg-background p-2" value={tracking}
          onChange={(event) => setTracking(event.target.value)} placeholder="UTMs, conversion event and reporting ID" />
      </label>
    </div>
    <button type="button" disabled={busy || !packageId || !owner.trim() || !budget.trim() || !tracking.trim()}
      onClick={() => void create()} className="rounded bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">
      Freeze operator bundle
    </button>
    {bundles.length === 0 && <p className="text-xs text-muted-foreground">No {platform} operator bundles recorded.</p>}
    {bundles.map((bundle) => {
      const source = sourceOf(bundle);
      const trail = events.filter((event) => event.bundle_id === bundle.id);
      const metric = matches[bundle.id];
      return <article key={bundle.id} className="rounded border border-border p-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">{String(source.campaign_name ?? "Campaign")} · v{bundle.version} · {current[bundle.id] ? "current" : "stale or unverified"}</p>
          <button type="button" className="underline" onClick={() => download(bundle)}>Download exact JSON</button>
        </div>
        <p className="mt-1 text-muted-foreground">SHA-256 {bundle.snapshot_hash} · {new Date(bundle.created_at).toLocaleString()}</p>
        <details className="mt-2"><summary className="cursor-pointer">Creative, offer, page, targeting, copy and instructions</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{JSON.stringify(bundle.snapshot, null, 2)}</pre>
        </details>
        <div className="mt-2 flex flex-wrap gap-3">{creativeFiles(bundle).map((file) =>
          <button key={file.asset_id} type="button" className="underline" onClick={() => {
            void downloadCreative(file).catch((cause: unknown) => setError(
              cause instanceof Error ? cause.message : "Could not verify creative bytes."));
          }}>Download verified {file.title || file.asset_id.slice(0, 8)}</button>)}</div>
        <div className="mt-2 flex flex-wrap gap-3">
          <button type="button" className="underline disabled:opacity-50" disabled={busy || !current[bundle.id]}
            onClick={() => void verifyDownload(bundle)}>Download and verify all files</button>
          <button type="button" className="underline disabled:opacity-50" disabled={busy || !current[bundle.id] || !trail.some((event) => event.event === "verified_download")}
            onClick={() => void record(bundle, "handoff_reported")}>Report handoff</button>
          <button type="button" className="underline disabled:opacity-50" disabled={busy || !current[bundle.id] || !trail.some((event) => event.event === "handoff_reported")}
            onClick={() => void record(bundle, "external_ids_reported")}>Report external IDs</button>
        </div>
        {trail.map((event) => <p key={event.id} className="mt-1 text-muted-foreground">
          {new Date(event.recorded_at).toLocaleString()} · {event.event.replaceAll("_", " ")} · {event.reference}
          {event.external_campaign_id ? ` · campaign ${event.external_campaign_id}` : ""}
          {event.external_ad_id ? ` · ad ${event.external_ad_id}` : ""}
        </p>)}
        <p className="mt-2 border-t border-border pt-2 text-muted-foreground">
          Metrics match: {metric?.match_state === "metric_rows_match_reported_id"
            ? `${metric.days_with_rows} daily row(s), latest ${metric.latest_metric_date ?? "date unknown"}`
            : metric?.match_state === "no_matching_metric_rows" ? "No rows match the reported campaign ID."
              : metric?.match_state === "provider_ingest_unavailable" ? "Provider ingest unavailable."
                : "Unknown; no external campaign ID has been reported."}
          {metric?.match_state === "metric_rows_match_reported_id" && <span className="block">
            Recorded spend {metric.recorded_spend == null ? "unknown" : `${metric.recorded_spend} ${metric.currency ?? "currency unknown"}`}
            {metric.currencies_seen > 1 ? " · multiple currencies" : ""}
            {` · impressions ${metric.recorded_impressions ?? "unknown"} · clicks ${metric.recorded_clicks ?? "unknown"} · conversions ${metric.recorded_conversions ?? "unknown"}`}
            {metric.latest_fetched_at ? ` · fetched ${new Date(metric.latest_fetched_at).toLocaleString()}` : ""}
          </span>}
          <span className="block">A matching metrics row does not verify provider account identity or ad activation.</span>
        </p>
      </article>;
    })}
  </section>;
}
