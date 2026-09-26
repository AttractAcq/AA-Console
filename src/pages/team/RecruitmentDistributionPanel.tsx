import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { supabase } from "../../lib/supabase";
import { adsManagerUrl, parseCountries } from "../../lib/metaBuild";
import { signPaths } from "../../lib/media";
import { useAgentJobs } from "../../lib/useAgentJobs";

type Brief = {
  id: string; title: string; recruitment_role: string | null;
  hook: string | null; script: string | null;
  apply_url: string | null; call_to_action: string | null;
};
type Asset = {
  id: string; brief_id: string | null; title: string | null;
  storage_path: string | null; media_type: string;
  content_format: string | null;
};
type Campaign = {
  id: string; name: string; daily_budget: number;
  target_countries: string[]; meta_campaign_id: string | null;
  meta_built_at: string | null; created_at: string;
};
type Integration = {
  status: string; ad_account_id: string | null;
  meta_page_id: string | null; meta_pixel_id: string | null;
};
type Job = { input_id: string | null; status: string; error: string | null };

export function RecruitmentDistributionPanel() {
  const [houseId, setHouseId] = useState<string | null>(null);
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("");
  const [countries, setCountries] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data: id, error: houseError } = await supabase.rpc("aa_house_client_id");
      if (houseError) throw houseError;
      const clientId = (id as string | null) ?? null;
      setHouseId(clientId);
      if (!clientId) { setLoading(false); return; }
      const [meta, images, copy, rows, jobRows] = await Promise.all([
        supabase.from("client_integrations")
          .select("status,ad_account_id,meta_page_id,meta_pixel_id")
          .eq("client_id", clientId).eq("provider", "meta").maybeSingle(),
        supabase.from("client_media_assets")
          .select("id,brief_id,title,storage_path,media_type,content_format")
          .eq("client_id", clientId).eq("purpose", "recruitment")
          .eq("review_status", "approved").order("created_at", { ascending: false }),
        supabase.from("client_briefs")
          .select("id,title,recruitment_role,hook,script,apply_url,call_to_action")
          .eq("client_id", clientId).eq("purpose", "recruitment"),
        supabase.from("recruitment_meta_campaigns").select("*")
          .eq("client_id", clientId).order("created_at", { ascending: false }),
        supabase.from("agent_jobs").select("input_id,status,error")
          .eq("agent_key", "recruitment_meta_build")
          .eq("client_id", clientId).order("created_at", { ascending: false }).limit(50),
      ]);
      const failure = meta.error ?? images.error ?? copy.error ?? rows.error ?? jobRows.error;
      if (failure) throw failure;
      setIntegration(meta.data as Integration | null);
      setAssets((images.data ?? []) as Asset[]);
      setBriefs((copy.data ?? []) as Brief[]);
      setCampaigns((rows.data ?? []) as Campaign[]);
      setJobs((jobRows.data ?? []) as Job[]);
      setUrls(await signPaths("client-media", (images.data ?? []).map((a) => a.storage_path)));
      setError(null);
    } catch (cause) {
      setError((cause as { message?: string }).message ?? "Could not load recruitment distribution.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useAgentJobs(houseId ?? undefined, refresh);

  const byBrief = useMemo(() => new Map(briefs.map((b) => [b.id, b])), [briefs]);
  const eligible = assets.filter((a) => {
    const brief = a.brief_id ? byBrief.get(a.brief_id) : null;
    return a.media_type === "image" && a.content_format !== "carousel" && Boolean(a.storage_path)
      && Boolean(brief?.hook?.trim() && brief.script?.trim() && brief.apply_url?.startsWith("https://")
        && ["APPLY_NOW", "LEARN_MORE", "SIGN_UP", "CONTACT_US"].includes(brief.call_to_action ?? ""));
  });
  const accountReady = Boolean(integration && ["connected", "active"].includes(integration.status)
    && integration.ad_account_id && integration.meta_page_id && integration.meta_pixel_id);
  const lastJob = (id: string) => jobs.find((job) => job.input_id === id);

  async function submit() {
    setError(null); setNotice(null);
    const dailyBudget = Number(budget);
    const targetCountries = parseCountries(countries);
    if (!name.trim()) { setError("Name the recruitment campaign."); return; }
    if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) { setError("Set a positive daily budget."); return; }
    if ("problem" in targetCountries) { setError(targetCountries.problem); return; }
    if (selected.length === 0) { setError("Select at least one approved recruitment ad."); return; }
    setBusy(true);
    const { error: createError } = await supabase.rpc("create_recruitment_meta_campaign", {
      p_name: name.trim(), p_daily_budget: dailyBudget,
      p_target_countries: targetCountries.codes, p_asset_ids: selected,
    });
    setBusy(false);
    if (createError) { setError(createError.message); return; }
    setSelected([]); setName(""); setBudget(""); setCountries("");
    setNotice("Queued. The selected ads will be built in AA's Ads Manager as a paused campaign.");
    void refresh();
  }

  async function retry(id: string) {
    setError(null); setNotice(null); setBusy(true);
    const { error: retryError } = await supabase.rpc("request_recruitment_meta_build", { p_campaign_id: id });
    setBusy(false);
    if (retryError) setError(retryError.message);
    else { setNotice("Recruitment Meta build queued again."); void refresh(); }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading recruitment distribution…</p>;
  return <div className="space-y-5">
    <div>
      <h2 className="text-lg font-semibold">Recruitment Distribution</h2>
      <p className="text-sm text-muted-foreground">Select approved AA hiring ads and build them in the house Meta ad account. Campaigns, ad sets and ads are created paused.</p>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
    <section className="rounded-lg border border-border p-4">
      <h3 className="font-semibold">AA Ads Manager</h3>
      {accountReady
        ? <p className="text-sm text-muted-foreground">Connected: {integration?.ad_account_id} · Page {integration?.meta_page_id} · Pixel {integration?.meta_pixel_id}</p>
        : <p className="text-sm text-destructive">Connect AA&apos;s Meta ad account, Facebook page and pixel on the house client before building recruitment ads.</p>}
    </section>
    <section className="space-y-3 rounded-lg border border-border p-4">
      <h3 className="font-semibold">New recruitment campaign</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">Campaign name<input aria-label="Campaign name" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded border border-input bg-background p-2" /></label>
        <label className="text-sm">Daily budget<input aria-label="Daily budget" type="number" min="0.01" step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} className="mt-1 w-full rounded border border-input bg-background p-2" /></label>
        <label className="text-sm">Countries<input aria-label="Countries" placeholder="ZA, GB" value={countries} onChange={(e) => setCountries(e.target.value)} className="mt-1 w-full rounded border border-input bg-background p-2" /></label>
      </div>
      <p className="text-xs text-muted-foreground">Daily budget uses the AA ad account&apos;s currency. The build optimises for completed applications and needs the connected pixel.</p>
      {eligible.length === 0 ? <p className="text-sm text-muted-foreground">No approved recruitment image has a complete brief and HTTPS apply URL yet.</p> :
        <fieldset className="space-y-2"><legend className="text-sm font-medium">Select ads</legend>
          {eligible.map((asset) => {
            const brief = byBrief.get(asset.brief_id ?? "");
            return <label key={asset.id} className="flex items-center gap-3 rounded border border-border p-2 text-sm">
              <input type="checkbox" checked={selected.includes(asset.id)} onChange={(e) => setSelected((current) => e.target.checked ? [...current, asset.id] : current.filter((id) => id !== asset.id))} />
              {asset.storage_path && urls.get(asset.storage_path) && <img src={urls.get(asset.storage_path)} alt="" className="h-12 w-12 rounded object-cover" />}
              <span>{asset.title ?? brief?.title ?? "Recruitment ad"}<span className="block text-xs text-muted-foreground">{brief?.recruitment_role ?? "Role"} · {brief?.hook}</span></span>
            </label>;
          })}
        </fieldset>}
      <Button onClick={() => void submit()} disabled={!accountReady || busy || eligible.length === 0}>Push selected ads to Ads Manager</Button>
    </section>
    <section className="space-y-2">
      <h3 className="font-semibold">Recruitment campaigns</h3>
      {campaigns.length === 0 ? <p className="text-sm text-muted-foreground">No recruitment campaigns built yet.</p> :
        campaigns.map((campaign) => {
          const job = lastJob(campaign.id);
          const running = job && ["queued", "claimed", "running"].includes(job.status);
          return <div key={campaign.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
            <div><p className="font-medium">{campaign.name}</p><p className="text-xs text-muted-foreground">{campaign.target_countries.join(", ")} · {campaign.daily_budget} per day · {campaign.meta_built_at ? "Ready in Ads Manager, paused" : running ? "Building" : job?.status === "failed" ? "Build failed" : "Waiting"}</p>
              {job?.error && <p className="text-xs text-destructive">{job.error}</p>}</div>
            <div className="flex gap-2">
              {campaign.meta_campaign_id && integration?.ad_account_id && <a className="rounded border border-border px-3 py-2 text-sm" href={adsManagerUrl(integration.ad_account_id, campaign.meta_campaign_id)} target="_blank" rel="noopener noreferrer">Open in Ads Manager</a>}
              {!campaign.meta_built_at && !running && <Button onClick={() => void retry(campaign.id)} disabled={busy}>Retry build</Button>}
            </div>
          </div>;
        })}
    </section>
  </div>;
}
