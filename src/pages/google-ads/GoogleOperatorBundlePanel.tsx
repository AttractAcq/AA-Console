import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Sheet = Database["public"]["Tables"]["google_ads_build_sheets"]["Row"];
type Bundle = Database["public"]["Tables"]["google_operator_bundles_v7"]["Row"];
type Event = Database["public"]["Tables"]["google_operator_events_v7"]["Row"];

const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

export function GoogleOperatorBundlePanel({ sheets }: { sheets: Sheet[] }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [sheetId, setSheetId] = useState("");
  const [owner, setOwner] = useState("");
  const [budget, setBudget] = useState("");
  const [tracking, setTracking] = useState("");
  const [research, setResearch] = useState("");
  const [headlines, setHeadlines] = useState("");
  const [descriptions, setDescriptions] = useState("");
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [current, setCurrent] = useState<Record<string, boolean>>({});
  const [eventBundleId, setEventBundleId] = useState("");
  const [eventType, setEventType] = useState("handoff_reported");
  const [reference, setReference] = useState("");
  const [externalCampaignId, setExternalCampaignId] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const result = await supabase.from("google_operator_bundles_v7").select("*")
      .eq("client_id", clientId).order("created_at", { ascending: false }).limit(50);
    if (result.error) throw new Error(result.error.message);
    const rows = result.data ?? [];
    setBundles(rows);
    if (rows[0]) setEventBundleId((previous) => previous || rows[0].id);
    const [checks, history] = await Promise.all([
      Promise.all(rows.map(async (row) => {
        const [approval, freshness] = await Promise.all([
          supabase.rpc("google_operator_bundle_approved_v7", { p_bundle_id: row.id }),
          supabase.rpc("google_operator_bundle_current_v7", { p_bundle_id: row.id }),
        ]);
        return { id: row.id, approved: approval.data === true, current: freshness.data === true };
      })),
      supabase.from("google_operator_events_v7").select("*")
        .eq("client_id", clientId).order("recorded_at", { ascending: false }).limit(100),
    ]);
    if (history.error) throw new Error(history.error.message);
    setEvents(history.data ?? []);
    setApproved(Object.fromEntries(checks.map((item) => [item.id, item.approved])));
    setCurrent(Object.fromEntries(checks.map((item) => [item.id, item.current])));
  }, [clientId]);

  useEffect(() => {
    const load = async () => {
      try { await refresh(); }
      catch (cause) { setError(String(cause)); }
    };
    void load();
  }, [refresh]);
  const selectedSheetId = sheetId || sheets[0]?.id || "";

  async function create() {
    if (!selectedSheetId || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await supabase.rpc("create_google_operator_bundle_v7", {
        p_sheet_id: selectedSheetId, p_owner: owner, p_budget_instruction: budget,
        p_tracking_instruction: tracking, p_research_task: research,
        p_headlines: lines(headlines), p_descriptions: lines(descriptions),
      });
      if (result.error) throw new Error(result.error.message);
      setNotice("Exact bundle frozen. Review it in the Approval Inbox before handoff.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function record(event: string, bundleId = eventBundleId, ref = reference) {
    if (!bundleId || !ref || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await supabase.rpc("record_google_operator_event_v7", {
        p_bundle_id: bundleId, p_event: event, p_reference: ref,
        ...(externalCampaignId ? { p_external_campaign_id: externalCampaignId } : {}),
        ...(detail ? { p_detail: detail } : {}),
      });
      if (result.error) throw new Error(result.error.message);
      setNotice("Operator report recorded. This is a human report, not a provider receipt.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function download(bundle: Bundle) {
    if (!approved[bundle.id] || !current[bundle.id] || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const exported = await supabase.rpc("google_operator_bundle_export_v7", {
        p_bundle_id: bundle.id,
      });
      if (exported.error || typeof exported.data !== "string")
        throw new Error(exported.error?.message ?? "Approved bundle export unavailable.");
      const bytes = new TextEncoder().encode(exported.data);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const actual = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (actual !== bundle.snapshot_hash) throw new Error("Export differs from the reviewed Google bundle.");
      const blob = new Blob([bytes], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `google-manual-bundle-${bundle.id}.json`;
      document.body.appendChild(link);
      link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const recorded = await supabase.rpc("record_google_operator_event_v7", {
        p_bundle_id: bundle.id, p_event: "verified_download",
        p_reference: `sha256:${actual}`,
      });
      if (recorded.error) throw new Error(recorded.error.message);
      setEventBundleId(bundle.id);
      setNotice("Exact reviewed bundle downloaded and verified. Record the operator handoff separately.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <section className="space-y-4 rounded-lg border border-border bg-card p-4">
    <div>
      <h3 className="font-semibold">Manual Google Ads operator bundle</h3>
      <p className="text-sm text-muted-foreground">Freeze the current sheet and human-written search copy for exact approval. Approval permits a manual handoff; it does not create or activate ads.</p>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">Versioned sheet<select className="mt-1 w-full rounded border border-border bg-background p-2" value={selectedSheetId} onChange={(event) => setSheetId(event.target.value)}>
        {sheets.map((sheet) => <option key={sheet.id} value={sheet.id}>Campaign {sheet.campaign_id} · sheet v{sheet.version}</option>)}
      </select></label>
      <label className="text-sm">Named paid operator<input className="mt-1 w-full rounded border border-border bg-background p-2" value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
      <label className="text-sm">Budget instruction<input className="mt-1 w-full rounded border border-border bg-background p-2" value={budget} onChange={(event) => setBudget(event.target.value)} /></label>
      <label className="text-sm">Tracking instruction<input className="mt-1 w-full rounded border border-border bg-background p-2" value={tracking} onChange={(event) => setTracking(event.target.value)} /></label>
      <label className="text-sm sm:col-span-2">Keyword research task<input className="mt-1 w-full rounded border border-border bg-background p-2" value={research} onChange={(event) => setResearch(event.target.value)} /></label>
      <label className="text-sm">Headlines, one per line (3–15, 30 characters each)<textarea className="mt-1 w-full rounded border border-border bg-background p-2" rows={5} value={headlines} onChange={(event) => setHeadlines(event.target.value)} /></label>
      <label className="text-sm">Descriptions, one per line (2–4, 90 characters each)<textarea className="mt-1 w-full rounded border border-border bg-background p-2" rows={5} value={descriptions} onChange={(event) => setDescriptions(event.target.value)} /></label>
    </div>
    <Button disabled={!selectedSheetId || busy} onClick={() => void create()}>Freeze bundle for approval</Button>
    <div className="space-y-2">
      {bundles.map((bundle) => <div key={bundle.id} className="rounded border border-border p-3 text-sm">
        <strong>Bundle v{bundle.version}</strong> · {bundle.snapshot_hash.slice(0, 12)} · {current[bundle.id] ? approved[bundle.id] ? "Approved" : "Awaiting approval" : "Superseded"}
        <div className="mt-2 flex flex-wrap gap-2">
          <Link className="text-brand-strong underline" to={`/clients/${clientId}/delivery/approval-inbox?tab=unified`}>Review exact version</Link>
          <Button disabled={!approved[bundle.id] || !current[bundle.id] || busy} onClick={() => void download(bundle)}>Download exact JSON</Button>
        </div>
      </div>)}
    </div>
    {bundles.length > 0 && <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
      <label className="text-sm">Approved bundle<select className="mt-1 w-full rounded border border-border bg-background p-2" value={eventBundleId} onChange={(event) => setEventBundleId(event.target.value)}>
        {bundles.filter((bundle) => approved[bundle.id] && current[bundle.id]).map((bundle) => <option key={bundle.id} value={bundle.id}>{bundle.id} · v{bundle.version}</option>)}
      </select></label>
      <label className="text-sm">Human report<select className="mt-1 w-full rounded border border-border bg-background p-2" value={eventType} onChange={(event) => setEventType(event.target.value)}>
        {["handoff_reported", "external_ids_reported", "activation_reported", "change_reported"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
      </select></label>
      <label className="text-sm">Evidence reference<input className="mt-1 w-full rounded border border-border bg-background p-2" value={reference} onChange={(event) => setReference(event.target.value)} /></label>
      <label className="text-sm">External campaign ID<input className="mt-1 w-full rounded border border-border bg-background p-2" value={externalCampaignId} onChange={(event) => setExternalCampaignId(event.target.value)} /></label>
      <label className="text-sm sm:col-span-2">Detail<input className="mt-1 w-full rounded border border-border bg-background p-2" value={detail} onChange={(event) => setDetail(event.target.value)} /></label>
      <Button disabled={!eventBundleId || !approved[eventBundleId] || !current[eventBundleId] || !reference || busy} onClick={() => void record(eventType)}>Record operator report</Button>
    </div>}
    {events.length > 0 && <ul className="space-y-1 text-xs">{events.map((event) => <li key={event.id}>{new Date(event.recorded_at).toLocaleString()} · {event.event.replaceAll("_", " ")} · {event.reference}{event.external_campaign_id ? ` · campaign ${event.external_campaign_id}` : ""}</li>)}</ul>}
  </section>;
}
