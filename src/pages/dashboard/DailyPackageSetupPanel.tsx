import { useCallback, useEffect, useState } from "react";
import { Panel } from "../../components/Panel";
import { callRuntime } from "../../lib/callRuntime";
import { supabase } from "../../lib/supabase";

type Settings = { enabled: boolean; campaign_id: string; pillar_id: string;
  platform: "facebook" | "instagram"; story_media_type: "image" | "video";
  approval_cutoff: string };
type Campaign = { id: string; name: string; built_at: string | null;
  audience: string | null; offer_summary: string | null };
type Pillar = { id: string; name: string };

/** Source inputs for a manually requested daily package; activation is separate. */
export function DailyPackageSetupPanel({ clientId }: { clientId: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [pillars, setPillars] = useState<Pillar[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [pillarId, setPillarId] = useState("");
  const [platform, setPlatform] = useState<"facebook" | "instagram">("instagram");
  const [storyMediaType, setStoryMediaType] = useState<"image" | "video">("image");
  const [approvalCutoff, setApprovalCutoff] = useState("09:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (active: () => boolean) => {
    const [settingsResult, campaignResult, pillarResult] = await Promise.all([
      supabase.from("client_daily_package_settings")
        .select("enabled,campaign_id,pillar_id,platform,story_media_type,approval_cutoff")
        .eq("client_id", clientId).maybeSingle(),
      supabase.from("client_campaigns")
        .select("id,name,built_at,audience,offer_summary")
        .eq("client_id", clientId).in("status", ["planning", "live"])
        .is("archived_at", null).order("name").limit(100),
      supabase.from("client_content_pillars")
        .select("id,name").eq("client_id", clientId).eq("active", true)
        .order("name").limit(100),
    ]);
    if (!active()) return;
    if (settingsResult.error || campaignResult.error || pillarResult.error) {
      setError(settingsResult.error?.message ?? campaignResult.error?.message
        ?? pillarResult.error?.message ?? "Could not read daily package setup.");
      return;
    }
    const row = settingsResult.data as Settings | null;
    setSettings(row);
    setCampaigns(((campaignResult.data ?? []) as Campaign[])
      .filter((campaign) => campaign.built_at && campaign.audience?.trim()
        && campaign.offer_summary?.trim()));
    setPillars((pillarResult.data ?? []) as Pillar[]);
    setCampaignId(row?.campaign_id ?? "");
    setPillarId(row?.pillar_id ?? "");
    setPlatform(row?.platform === "facebook" ? "facebook" : "instagram");
    setStoryMediaType(row?.story_media_type === "video" ? "video" : "image");
    setApprovalCutoff(row?.approval_cutoff?.slice(0, 5) ?? "09:00");
    setError(null);
  }, [clientId]);

  useEffect(() => {
    let active = true;
    void refresh(() => active);
    return () => { active = false; };
  }, [refresh]);

  async function save() {
    setBusy(true); setError(null); setNotice(null);
    try {
      await callRuntime("/admin/video/daily", { action: "setup", clientId,
        campaignId, pillarId, platform, storyMediaType, approvalCutoff });
      setNotice("Daily package inputs saved. Production remains off until its switch is approved and enabled.");
      await refresh(() => true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save daily package inputs.");
    } finally { setBusy(false); }
  }

  return <Panel title="Daily package setup">
    <p className="text-xs text-muted-foreground">Prepare the campaign, content pillar and posting context for a manually requested code-video day. Saving these inputs does not start production or publication.</p>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    {notice && <p role="status" className="mt-2 text-xs">{notice}</p>}
    <p className="mt-2 text-xs">Daily production switch: {settings ? settings.enabled ? "on" : "off" : "not set up"}</p>
    {settings?.enabled && <p className="mt-1 text-xs text-muted-foreground">Switch daily production off before changing its inputs.</p>}
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="text-xs">Built campaign
        <select aria-label="Daily package campaign" value={campaignId}
          onChange={(event) => setCampaignId(event.target.value)}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="">Choose campaign</option>
          {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
        </select>
      </label>
      <label className="text-xs">Active content pillar
        <select aria-label="Daily package pillar" value={pillarId}
          onChange={(event) => setPillarId(event.target.value)}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="">Choose pillar</option>
          {pillars.map((pillar) => <option key={pillar.id} value={pillar.id}>{pillar.name}</option>)}
        </select>
      </label>
      <label className="text-xs">Destination
        <select aria-label="Daily package destination" value={platform}
          onChange={(event) => setPlatform(event.target.value as typeof platform)}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="instagram">Instagram</option><option value="facebook">Facebook</option>
        </select>
      </label>
      <label className="text-xs">Story format
        <select aria-label="Daily package story format" value={storyMediaType}
          onChange={(event) => setStoryMediaType(event.target.value as typeof storyMediaType)}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="image">Image</option><option value="video">Video</option>
        </select>
      </label>
      <label className="text-xs">Local approval cutoff
        <input aria-label="Daily package approval cutoff" type="time" value={approvalCutoff}
          onChange={(event) => setApprovalCutoff(event.target.value)}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
      </label>
    </div>
    <button type="button" disabled={busy || settings?.enabled === true || !campaignId || !pillarId || !approvalCutoff}
      onClick={() => void save()} className="mt-3 rounded-md border border-border px-3 py-2 text-xs disabled:opacity-50">
      Save daily package inputs
    </button>
  </Panel>;
}
