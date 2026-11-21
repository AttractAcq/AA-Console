import { useCallback, useEffect, useState } from "react";

import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Bundle = Database["public"]["Tables"]["paid_operator_bundles_v7"]["Row"];
type Event = Database["public"]["Tables"]["paid_operator_events_v7"]["Row"];
type Package = Pick<Database["public"]["Tables"]["campaign_preparation_packages_v7"]["Row"],
  "id" | "campaign_id" | "version" | "assembled_at">;
type Campaign = Pick<Database["public"]["Tables"]["client_campaigns"]["Row"],
  "id" | "name" | "paid_platform">;
type MetaAccountMatch = Database["public"]["Views"]["meta_operator_account_match_v7"]["Row"];
type MetricMatch = { bundle_id: string; match_state: string; external_campaign_id: string | null;
  latest_metric_date: string | null; latest_fetched_at: string | null; days_with_rows: number;
  recorded_spend: number | null; recorded_impressions: number | null;
  recorded_clicks: number | null; recorded_conversions: number | null;
  currency: string | null; currencies_seen: number;
  configured_customer_id?: string | null; read_run_id?: string | null;
  provider_request_id?: string | null; from_date?: string | null; through_date?: string | null };

function sourceOf(bundle: Bundle): Record<string, unknown> {
  const snapshot = bundle.snapshot;
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    && snapshot.source && typeof snapshot.source === "object" && !Array.isArray(snapshot.source)
    ? snapshot.source as Record<string, unknown> : {};
}

type CreativeFile = { asset_id: string; storage_path: string; file_sha256: string;
  frame_id?: string; position?: number; title?: string };

function isCreativeFile(value: unknown): value is CreativeFile {
  return !!value && typeof value === "object"
    && typeof (value as CreativeFile).asset_id === "string"
    && typeof (value as CreativeFile).storage_path === "string"
    && typeof (value as CreativeFile).file_sha256 === "string";
}

function creativeFiles(bundle: Bundle): CreativeFile[] {
  const creative = sourceOf(bundle).creative;
  if (!Array.isArray(creative)) return [];
  return creative.flatMap((item) => item && typeof item === "object" && Array.isArray(item.files)
    ? item.files.filter(isCreativeFile) : isCreativeFile(item) ? [item] : []);
}

function completeMetaCreative(creative: unknown, files: CreativeFile[]): boolean {
  return Array.isArray(creative) && creative.length > 0
    && creative.every((item) => item && typeof item === "object"
      && typeof item.asset_id === "string"
      && (Array.isArray(item.files)
        ? item.files.length > 0 && item.files.every(isCreativeFile)
          && item.files.every((file: CreativeFile) => file.asset_id === item.asset_id)
        : isCreativeFile(item)))
    && files.length === creative.reduce((count, item) => count
      + (Array.isArray(item.files) ? item.files.length : 1), 0);
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

export function PaidOperatorBundles({ clientId, platform, campaignId }: {
  clientId: string | undefined; platform: "meta" | "google"; campaignId?: string;
}) {
  return <PaidOperatorBundlesForClient key={`${clientId ?? "no-client"}:${platform}:${campaignId ?? "all"}`}
    clientId={clientId} platform={platform} campaignId={campaignId} />;
}

function PaidOperatorBundlesForClient({ clientId, platform, campaignId }: {
  clientId: string | undefined; platform: "meta" | "google"; campaignId?: string;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [packages, setPackages] = useState<Package[]>([]);
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [current, setCurrent] = useState<Record<string, boolean>>({});
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [matches, setMatches] = useState<Record<string, MetricMatch>>({});
  const [metaAccountMatches, setMetaAccountMatches] = useState<Record<string, MetaAccountMatch>>({});
  const [packageId, setPackageId] = useState("");
  const [owner, setOwner] = useState("");
  const [budget, setBudget] = useState("");
  const [tracking, setTracking] = useState("");
  const [researchTask, setResearchTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    try {
      const [c, p, b, e, m, metaAccount] = await Promise.all([
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
        supabase.from(platform === "google" ? "paid_google_operator_account_match_v7" : "paid_operator_metric_match_v7").select("*")
          .eq("client_id", clientId).eq("platform", platform).limit(50),
        platform === "meta" ? supabase.from("meta_operator_account_match_v7").select("*")
          .eq("client_id", clientId).limit(50) : Promise.resolve({ data: [], error: null }),
      ]);
      for (const result of [c, p, b, e, m, metaAccount]) if (result.error) throw result.error;
      const campaigns = ((c.data ?? []) as Campaign[]).filter((row) =>
        !campaignId || row.id === campaignId);
      const campaignIds = new Set(campaigns.map((item) => item.id));
      const latest = new Map<string, Package>();
      for (const row of (p.data ?? []) as Package[]) {
        if (campaignIds.has(row.campaign_id) && !latest.has(row.campaign_id)) latest.set(row.campaign_id, row);
      }
      const visibleBundles = ((b.data ?? []) as Bundle[]).filter((row) =>
        !campaignId || row.campaign_id === campaignId);
      const checks = await Promise.all(visibleBundles.map(async (row) => {
        const [source, decision] = await Promise.all([
          supabase.rpc("paid_operator_bundle_current_v7", { p_bundle_id: row.id }),
          supabase.rpc("paid_operator_bundle_approved_v7", { p_bundle_id: row.id }),
        ]);
        if (source.error || decision.error) {
          throw new Error(`Exact review status is unavailable for bundle ${row.id}: ${
            source.error?.message ?? decision.error?.message}`);
        }
        return [row.id, source.data === true, decision.data === true] as const;
      }));
      setCampaigns(campaigns);
      setPackages([...latest.values()]);
      setBundles(visibleBundles);
      setEvents(((e.data ?? []) as Event[]).filter((row) =>
        visibleBundles.some((bundle) => bundle.id === row.bundle_id)));
      setCurrent(Object.fromEntries(checks.map(([id, isCurrent]) => [id, isCurrent])));
      setApproved(Object.fromEntries(checks.map(([id, , isApproved]) => [id, isApproved])));
      setMatches(Object.fromEntries(((m.data ?? []) as MetricMatch[])
        .map((row) => [row.bundle_id, row])));
      setMetaAccountMatches(Object.fromEntries(((metaAccount.data ?? []) as MetaAccountMatch[])
        .filter((row) => row.bundle_id !== null).map((row) => [row.bundle_id!, row])));
      setError(null);
    } catch (cause) {
      // A failed refresh must not leave a previously approved bundle actionable.
      setCampaigns([]);
      setPackages([]);
      setPackageId("");
      setBundles([]);
      setEvents([]);
      setCurrent({});
      setApproved({});
      setMatches({});
      setMetaAccountMatches({});
      setError(cause instanceof Error ? cause.message : "Could not load operator bundles.");
    }
  }, [clientId, platform, campaignId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    if (!packageId || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = platform === "google"
        ? await supabase.rpc("create_google_paid_operator_bundle_v7", {
          p_package_id: packageId, p_owner: owner, p_budget_instruction: budget,
          p_tracking_instruction: tracking, p_research_task: researchTask,
        })
        : await supabase.rpc("create_paid_operator_bundle_v7", {
          p_package_id: packageId, p_owner: owner, p_budget_instruction: budget,
          p_tracking_instruction: tracking,
        });
      if (result.error) throw result.error;
      setNotice(`Exact ${platform === "meta" ? "Meta" : "Google"} operator bundle frozen. Review its exact instructions and source in Approval Inbox before downloading.`);
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

  const downloadExactJson = async (bundle: Bundle) => {
    const result = await supabase.rpc("paid_operator_bundle_export_v7", {
      p_bundle_id: bundle.id,
    });
    if (result.error || typeof result.data !== "string") {
      throw new Error(result.error?.message ?? "Current operator packet is unavailable.");
    }
    const bytes = new TextEncoder().encode(result.data);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actual = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== bundle.snapshot_hash) throw new Error("Operator packet differs from its reviewed hash.");
    const blob = new Blob([bytes], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `${platform}-operator-bundle-v${bundle.version}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return actual;
  };

  const verifyDownload = async (bundle: Bundle) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const files = creativeFiles(bundle);
      const creative = sourceOf(bundle).creative;
      if (platform === "meta" && !completeMetaCreative(creative, files))
        throw new Error("The exact Meta bundle has missing or incomplete creative files.");
      if (platform === "google" && (!Array.isArray(creative) || creative.length === 0
        || !creative.every((item) => item && typeof item === "object"
          && typeof item.copy_id === "string" && typeof item.copy_hash === "string"
          && Array.isArray(item.headlines) && Array.isArray(item.descriptions)))) {
        throw new Error("The exact Google bundle has no reviewed search-copy versions.");
      }
      const actual = await downloadExactJson(bundle);
      for (const file of files) await downloadCreative(file);
      const result = await supabase.rpc("record_paid_operator_event_v7", {
        p_bundle_id: bundle.id, p_event: "verified_download",
        p_reference: `sha256:${actual}`,
      });
      if (result.error) throw result.error;
      setNotice("Exact bundle bytes verified and downloaded. This is a browser report, not an external handoff receipt.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not verify the bundle files.");
    } finally { setBusy(false); }
  };

  return <section className="space-y-4 rounded-lg border border-border bg-card p-4" aria-label={`${platform} paid operator bundles`}>
    <div>
      <h3 className="font-semibold">{platform === "google" ? "Campaign-bound Google operator bundles" : "Meta paid operator bundles"}</h3>
      <p className="text-xs text-muted-foreground">A current approved campaign package, exact creative signoff and separate human review of this frozen operator bundle are required. Handoff and external IDs are operator reports; no ad is built or activated here.</p>
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
      {platform === "google" && <div className="text-xs sm:col-span-2">
        <label>Keyword research task
          <textarea className="mt-1 w-full rounded border border-border bg-background p-2" value={researchTask}
            onChange={(event) => setResearchTask(event.target.value)}
            placeholder="Research search terms, match types, negatives, geography and intent before activating ads" />
        </label>
        <span className="mt-1 block text-muted-foreground">Campaign ideas are seeds. This assigns research to the paid operator; it does not claim the research is complete.</span>
      </div>}
    </div>
    <button type="button" disabled={busy || !packageId || !owner.trim() || !budget.trim() || !tracking.trim()
      || (platform === "google" && !researchTask.trim())}
      onClick={() => void create()} className="rounded bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">
      Freeze operator bundle
    </button>
    {bundles.length === 0 && <p className="text-xs text-muted-foreground">No {platform} operator bundles recorded.</p>}
    {bundles.map((bundle) => {
      const source = sourceOf(bundle);
      const ready = current[bundle.id] === true && approved[bundle.id] === true;
      const trail = events.filter((event) => event.bundle_id === bundle.id);
      const metric = matches[bundle.id];
      const metaAccount = metaAccountMatches[bundle.id];
      return <article key={bundle.id} className="rounded border border-border p-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">{String(source.campaign_name ?? "Campaign")} · v{bundle.version} · {current[bundle.id] ? approved[bundle.id] ? "approved and current" : "not approved" : "stale or unverified"}</p>
          <button type="button" className="underline disabled:opacity-50" disabled={busy || !ready}
            onClick={() => void downloadExactJson(bundle).catch((cause: unknown) => setError(
              cause instanceof Error ? cause.message : "Could not verify operator packet bytes."))}>
            Download exact JSON
          </button>
        </div>
        <p className="mt-1 text-muted-foreground">SHA-256 {bundle.snapshot_hash} · {new Date(bundle.created_at).toLocaleString()}</p>
        <details className="mt-2"><summary className="cursor-pointer">Creative, offer, page, targeting, copy and instructions</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{JSON.stringify(bundle.snapshot, null, 2)}</pre>
        </details>
        <div className="mt-2 flex flex-wrap gap-3">{creativeFiles(bundle).map((file) =>
          <button key={`${file.asset_id}:${file.frame_id ?? "single"}`} type="button"
            className="underline disabled:opacity-50" disabled={busy || !ready} onClick={() => {
            void downloadCreative(file).catch((cause: unknown) => setError(
              cause instanceof Error ? cause.message : "Could not verify creative bytes."));
          }}>Download verified {file.title || file.asset_id.slice(0, 8)}{file.position ? ` · frame ${file.position}` : ""}</button>)}</div>
        <div className="mt-2 flex flex-wrap gap-3">
          <button type="button" className="underline disabled:opacity-50" disabled={busy || !ready}
            onClick={() => void verifyDownload(bundle)}>{platform === "google" ? "Download and verify Google packet" : "Download and verify all files"}</button>
          <button type="button" className="underline disabled:opacity-50" disabled={busy || !ready || !trail.some((event) => event.event === "verified_download")}
            onClick={() => void record(bundle, "handoff_reported")}>Report handoff</button>
          <button type="button" className="underline disabled:opacity-50" disabled={busy || !ready || !trail.some((event) => event.event === "handoff_reported")}
            onClick={() => void record(bundle, "external_ids_reported")}>Report external IDs</button>
        </div>
        {trail.map((event) => <p key={event.id} className="mt-1 text-muted-foreground">
          {new Date(event.recorded_at).toLocaleString()} · {event.event.replaceAll("_", " ")} · {event.reference}
          {event.external_campaign_id ? ` · campaign ${event.external_campaign_id}` : ""}
          {event.external_ad_id ? ` · ad ${event.external_ad_id}` : ""}
        </p>)}
        {platform === "meta" && <p className="mt-2 border-t border-border pt-2 text-muted-foreground">
          Configured Meta account read: {metaAccount?.match_state === "observed_in_meta_account"
            ? `Reported campaign${metaAccount.reported_ad_id ? " and ad" : ""} observed in the configured account.`
            : metaAccount?.match_state === "reported_ad_not_observed"
              ? "Reported campaign observed, but reported ad absent from the latest account read."
            : metaAccount?.match_state === "reported_campaign_not_observed"
              ? "Reported campaign absent from the latest configured account read."
            : metaAccount?.match_state === "no_current_account_read"
              ? "No current read of the configured Meta account and credential."
            : metaAccount?.match_state === "no_meta_account_configured"
              ? "No Meta ad account configured."
              : "Unknown; no external campaign ID has been reported."}
          {metaAccount?.read_run_id && <span className="block">
            Account {metaAccount.configured_account_id ?? "unknown"} · read {metaAccount.read_run_id}
            {metaAccount.fetched_at ? ` · fetched ${new Date(metaAccount.fetched_at).toLocaleString()}` : ""}
            {metaAccount.observed_campaign_status ? ` · campaign ${metaAccount.observed_campaign_status}` : ""}
            {metaAccount.observed_ad_status ? ` · ad ${metaAccount.observed_ad_status}` : ""}
          </span>}
          <span className="block">An account read records observed IDs and status; it does not prove who activated the ad or that it caused a sale.</span>
        </p>}
        <p className="mt-2 border-t border-border pt-2 text-muted-foreground">
          Metrics match: {metric?.match_state === "metric_rows_match_reported_id"
            ? platform === "google"
              ? `Campaign ID observed in the configured Google customer; metrics returned for ${metric.from_date ?? "unknown start"} to ${metric.through_date ?? "unknown end"}`
              : `${metric.days_with_rows} daily row(s), latest ${metric.latest_metric_date ?? "date unknown"}`
            : metric?.match_state === "provider_campaign_observed_metrics_unknown"
              ? "Campaign ID observed in the configured Google customer; period metrics unknown."
            : metric?.match_state === "reported_id_not_observed"
              ? "Reported campaign ID absent from the latest configured Google account read."
            : metric?.match_state === "no_current_account_read"
              ? "No current read of the configured Google customer and credential."
            : metric?.match_state === "multiple_google_accounts_configured"
              ? "Multiple Google account integrations recorded; choose one before reconciliation."
            : metric?.match_state === "no_google_account_configured"
              ? "No Google Ads customer configured."
            : metric?.match_state === "no_matching_metric_rows" ? "No rows match the reported campaign ID."
              : metric?.match_state === "provider_ingest_unavailable" ? "Provider ingest unavailable."
                : "Unknown; no external campaign ID has been reported."}
          {metric?.match_state === "metric_rows_match_reported_id" && <span className="block">
            Recorded spend {metric.recorded_spend == null ? "unknown" : `${metric.recorded_spend} ${metric.currency ?? "currency unknown"}`}
            {metric.currencies_seen > 1 ? " · multiple currencies" : ""}
            {` · impressions ${metric.recorded_impressions ?? "unknown"} · clicks ${metric.recorded_clicks ?? "unknown"} · conversions ${metric.recorded_conversions ?? "unknown"}`}
            {metric.latest_fetched_at ? ` · fetched ${new Date(metric.latest_fetched_at).toLocaleString()}` : ""}
          </span>}
          {platform === "google" && metric?.read_run_id && <span className="block">
            Customer {metric.configured_customer_id ?? "unknown"} · read {metric.read_run_id} · provider request {metric.provider_request_id ?? "unknown"}
            {metric.latest_fetched_at ? ` · fetched ${new Date(metric.latest_fetched_at).toLocaleString()}` : ""}
          </span>}
          <span className="block">{platform === "google"
            ? "A recorded Google account read does not prove ad activation or sale causation."
            : "A matching metrics row does not verify provider account identity or ad activation."}</span>
        </p>
      </article>;
    })}
  </section>;
}
