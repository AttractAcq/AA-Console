import { useCallback, useEffect, useState } from "react";
import { callRuntime } from "../../lib/callRuntime";
import { supabase } from "../../lib/supabase";

type Settings = { campaign_id: string; enabled: boolean; platform: string;
  story_media_type: string };
type Configuration = { route_package_id: string; model_record_ids: string[] };
type Route = { id: string; version: number; route: string };
type Source = { record_id: string; title: string; domain: string };

export function DailyCodeVideoControls({ clientId, onPlanned }: {
  clientId: string; onPlanned: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [configured, setConfigured] = useState<Configuration | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [routeId, setRouteId] = useState("");
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [packageDay, setPackageDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (active: () => boolean) => {
    const [settingsResult, configuredResult, sourceResult] = await Promise.all([
      supabase.from("client_daily_package_settings")
        .select("campaign_id,enabled,platform,story_media_type")
        .eq("client_id", clientId).maybeSingle(),
      supabase.from("client_daily_video_sources_v1")
        .select("route_package_id,model_record_ids")
        .eq("client_id", clientId).maybeSingle(),
      supabase.from("model_section_review_state_v7")
        .select("record_id,title,domain")
        .eq("client_id", clientId).eq("review_state", "supported")
        .order("title").limit(100),
    ]);
    if (!active()) return;
    if (settingsResult.error || configuredResult.error || sourceResult.error) {
      setError(settingsResult.error?.message ?? configuredResult.error?.message
        ?? sourceResult.error?.message ?? "Could not read daily video setup.");
      return;
    }
    const nextSettings = settingsResult.data as Settings | null;
    const nextConfiguration = configuredResult.data as Configuration | null;
    setSettings(nextSettings);
    setConfigured(nextConfiguration);
    setSources((sourceResult.data ?? []) as Source[]);
    setRouteId(nextConfiguration?.route_package_id ?? "");
    setSourceIds(nextConfiguration?.model_record_ids ?? []);
    setError(null);
    if (!nextSettings) { setRoutes([]); return; }
    const routeResult = await supabase.from("campaign_route_packages_v6")
      .select("id,version,route")
      .eq("client_id", clientId).eq("campaign_id", nextSettings.campaign_id)
      .eq("route", "organic").order("version", { ascending: false }).limit(30);
    if (!active()) return;
    if (routeResult.error) { setError(routeResult.error.message); return; }
    setRoutes((routeResult.data ?? []) as Route[]);
  }, [clientId]);

  useEffect(() => {
    let active = true;
    void load(() => active);
    return () => { active = false; };
  }, [load]);

  const toggleSource = (id: string) => setSourceIds((current) =>
    current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  async function configure() {
    setBusy(true); setError(null); setNotice(null);
    try {
      await callRuntime("/admin/video/daily", { action: "configure", clientId,
        routePackageId: routeId, modelRecordIds: sourceIds });
      setNotice("Current route and reviewed sources saved. The daily Engine was not switched on.");
      await load(() => true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save daily video sources."); }
    finally { setBusy(false); }
  }

  async function plan() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await callRuntime<{ packageId: string; runId: string }>(
        "/admin/video/daily", { action: "plan", clientId, packageDay });
      setNotice(`Daily code-video package requested for ${packageDay}. Request ID: ${result.runId}`);
      onPlanned();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not request a daily package."); }
    finally { setBusy(false); }
  }

  return <section className="mb-5 rounded-lg border border-border bg-card p-4" aria-label="Daily code-video controls">
    <h2 className="font-semibold">Daily code-video preparation</h2>
    <p className="mt-1 text-xs text-muted-foreground">An assigned manager or admin with two-factor authentication can choose the current organic campaign route and supported model sources, then request one day. Production stops at human asset review; publication has a separate gate.</p>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    {notice && <p role="status" className="mt-2 text-xs">{notice}</p>}
    {!settings && <p className="mt-2 text-xs text-muted-foreground">Daily package settings need a campaign and content pillar before code-video preparation can be requested.</p>}
    {settings && <div className="mt-3 space-y-3">
      <p className="text-xs">Daily package: {settings.enabled ? "on" : "off"} · {settings.platform} · story {settings.story_media_type}</p>
      <label className="block text-xs">Organic route
        <select aria-label="Daily video organic route" value={routeId}
          onChange={(event) => setRouteId(event.target.value)}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="">Choose current route</option>
          {routes.map((route) => <option key={route.id} value={route.id}>Organic route v{route.version}</option>)}
        </select>
      </label>
      <fieldset className="space-y-1 text-xs"><legend>Supported model sources (1–12)</legend>
        {sources.map((source) => <label key={source.record_id} className="flex items-start gap-2">
          <input type="checkbox" checked={sourceIds.includes(source.record_id)}
            onChange={() => toggleSource(source.record_id)} />
          <span>{source.title} · {source.domain}</span>
        </label>)}
        {!sources.length && <p>No supported model sections are available.</p>}
      </fieldset>
      <button type="button" disabled={busy || !routeId || sourceIds.length < 1 || sourceIds.length > 12}
        onClick={() => void configure()} className="rounded-md border border-border px-3 py-2 text-xs disabled:opacity-50">
        Save daily video sources
      </button>
      <label className="block text-xs">Package day
        <input aria-label="Daily video package day" type="date" value={packageDay}
          onChange={(event) => setPackageDay(event.target.value)}
          className="mt-1 block rounded-md border border-input bg-background px-3 py-2 text-sm" />
      </label>
      <button type="button" disabled={busy || !settings.enabled || !configured || !packageDay}
        onClick={() => void plan()} className="rounded-md border border-border px-3 py-2 text-xs disabled:opacity-50">
        Request code-video day
      </button>
      {!settings.enabled && <p className="text-xs text-muted-foreground">The client daily package switch is off. It must be enabled before a request can run.</p>}
    </div>}
  </section>;
}
