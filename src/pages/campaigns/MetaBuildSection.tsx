import { useCallback, useEffect, useMemo, useState } from "react";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { supabase } from "../../lib/supabase";
import { templateFor } from "../../lib/campaignTemplates";
import { cn } from "../../lib/cn";
import { adsManagerUrl, parseCountries, parseMetaObjectId } from "../../lib/metaBuild";

export type MetaCampaign = {
  id: string;
  name: string;
  template: string | null;
  mirrors_template: string | null;
  daily_budget: number | null;
  target_countries: string[] | null;
  conversion_event: string | null;
  meta_campaign_id: string | null;
  meta_ad_set_id: string | null;
  meta_built_at: string | null;
};

type Integration = {
  status: string;
  ad_account_id: string | null;
  meta_page_id: string | null;
  meta_pixel_id: string | null;
};

type LastBuild = { status: string; error: string | null; completed_at: string | null };

const buttonClass =
  "rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Pixel events a conversion goal can count. Kept in step with migration 125's check. */
const CONVERSION_EVENTS = [
  "LEAD", "PURCHASE", "COMPLETE_REGISTRATION", "CONTACT", "SCHEDULE", "SUBMIT_APPLICATION",
  "INITIATED_CHECKOUT", "ADD_TO_CART", "SUBSCRIBE", "START_TRIAL", "CONTENT_VIEW",
];

const FIELDS: FieldDef[] = [
  {
    name: "daily_budget",
    label: "Daily budget",
    kind: "number",
    required: true,
    hint: "Per day, in the ad account's own currency. The build reads the currency from Meta.",
  },
  {
    name: "target_countries",
    label: "Countries",
    kind: "text",
    required: true,
    placeholder: "ZA, GB",
    hint: "Two-letter country codes, separated by commas.",
  },
  {
    name: "conversion_event",
    label: "Conversion event",
    kind: "select",
    options: CONVERSION_EVENTS.map((e) => ({ value: e, label: e.replace(/_/g, " ").toLowerCase() })),
    hint: "Only needed for templates that optimise for conversions (R1–R3, C1, C2, O1). Needs a pixel on the Meta integration.",
  },
];

/**
 * Recording a structure somebody created in Ads Manager themselves.
 *
 * The ad set is optional because a hand build can legitimately stop after the
 * campaign, and build.ts treats a campaign with no ad set as a partial build it
 * can finish. The reverse — an ad set with no campaign — is the state it
 * refuses, so this never writes one without the other.
 */
const HAND_BUILD_FIELDS: FieldDef[] = [
  {
    name: "meta_campaign_id",
    label: "Meta campaign id",
    kind: "text",
    required: true,
    hint: "From the id column in Ads Manager. Digits only.",
  },
  {
    name: "meta_ad_set_id",
    label: "Ad set id",
    kind: "text",
    hint: "Leave empty if only the campaign exists so far.",
  },
];

/**
 * Building a campaign in Meta.
 *
 * The checklist is the obvious prerequisites, shown so nobody presses Build
 * to find out a budget is missing. It is not the full check: the build runs
 * that itself before sending anything, and says everything it found wrong.
 */
export function MetaBuildSection({
  clientId,
  campaign,
  building,
  onChanged,
}: {
  clientId: string;
  campaign: MetaCampaign;
  /** A meta_build job for this campaign is queued or running. */
  building: boolean;
  onChanged: () => void;
}) {
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [lastBuild, setLastBuild] = useState<LastBuild | null>(null);
  const [editing, setEditing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [meta, job] = await Promise.all([
      supabase
        .from("client_integrations")
        .select("status, ad_account_id, meta_page_id, meta_pixel_id")
        .eq("client_id", clientId)
        .eq("provider", "meta")
        .maybeSingle(),
      supabase
        .from("agent_jobs")
        .select("status, error, completed_at")
        .eq("agent_key", "meta_build")
        .eq("input_table", "client_campaigns")
        .eq("input_id", campaign.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    setIntegration((meta.data as Integration | null) ?? null);
    setLastBuild((job.data as LastBuild | null) ?? null);
  }, [clientId, campaign.id]);

  // Reloads when a build starts or settles, which is when the answer changes.
  useEffect(() => {
    void load();
  }, [load, building, campaign.meta_built_at]);

  // Memoised: the card re-renders whenever a job moves, and a new object
  // here would reset the settings form while someone is typing in it.
  const initialValues = useMemo(
    () => ({
      daily_budget: campaign.daily_budget ? String(campaign.daily_budget) : "",
      target_countries: (campaign.target_countries ?? []).join(", "),
      conversion_event: campaign.conversion_event ?? "",
    }),
    // Joined, because each refresh hands over a new array with the same codes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [campaign.daily_budget, (campaign.target_countries ?? []).join(","), campaign.conversion_event],
  );

  const handBuildValues = useMemo(
    () => ({
      meta_campaign_id: campaign.meta_campaign_id ?? "",
      meta_ad_set_id: campaign.meta_ad_set_id ?? "",
    }),
    [campaign.meta_campaign_id, campaign.meta_ad_set_id],
  );

  const template = templateFor(campaign.template);
  const checks = [
    {
      label: "Template points at a page",
      met: template?.destination === "page",
      detail: template
        ? template.destination === "page"
          ? `${template.code} · ${template.name}`
          : `${template.code} sends people to ${template.destination.replace("_", " ")}, which cannot be built yet.`
        : "No template. Pick one when planning the campaign.",
    },
    {
      label: "Daily budget and countries",
      met: Boolean(campaign.daily_budget) && (campaign.target_countries ?? []).length > 0,
      detail:
        campaign.daily_budget && (campaign.target_countries ?? []).length > 0
          ? `${campaign.daily_budget} a day in ${(campaign.target_countries ?? []).join(", ")}`
          : "Set these below.",
    },
    {
      label: "Meta ad account and page",
      met: Boolean(integration?.ad_account_id && integration.meta_page_id),
      detail: !integration
        ? "No Meta integration. Connect one in Account → Integrations."
        : !integration.meta_page_id
          ? "The Meta integration has no Facebook page. Add it in Account → Integrations."
          : `${integration.ad_account_id ?? "No ad account id"} · page ${integration.meta_page_id}`,
    },
  ];

  /**
   * The sheet, for when there is no usable token.
   *
   * Queued rather than rendered here: the objective and the payload rules live
   * in the runtime, and a copy of them in the app would drift from the one that
   * actually sends. The runner writes the sheet into its own job log.
   */
  const requestSheet = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error: rpcError } = await supabase.rpc("request_meta_build_sheet", { p_campaign_id: campaign.id });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setNotice(
      "Queued. The sheet appears in the Meta Build Sheet agent's log; it sends nothing to Meta and changes nothing here.",
    );
    onChanged();
  };

  const request = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error: rpcError } = await supabase.rpc("request_meta_build", { p_campaign_id: campaign.id });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setNotice("Queued. Everything is created paused; nothing spends until someone launches it in Ads Manager.");
    onChanged();
  };

  return (
    <div className="mt-3 border-t border-border pt-3" aria-label="Meta build">
      <h4 className="text-xs font-semibold text-foreground">Meta ads</h4>
      <ul className="mt-2 space-y-1">
        {checks.map((c) => (
          <li key={c.label} className="flex items-baseline gap-2 text-xs">
            <span
              aria-hidden
              className={cn(
                "inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full",
                c.met ? "bg-brand-strong" : "bg-destructive",
              )}
            />
            <span className="font-medium text-card-foreground">{c.label}</span>
            <span className="text-muted-foreground">{c.detail}</span>
          </li>
        ))}
        <li className="text-xs text-muted-foreground">
          Only approved images with ad copy are built. Write the copy under Content production.
        </li>
      </ul>

      {campaign.meta_campaign_id && (
        <p className="mt-2 text-xs text-muted-foreground">
          {campaign.meta_built_at
            ? `Built in Meta ${new Date(campaign.meta_built_at).toLocaleString()}, paused.`
            : "Partly built in Meta. Building again finishes what is missing."}{" "}
          {integration?.ad_account_id && (
            <a
              className="text-brand-strong hover:underline"
              href={adsManagerUrl(integration.ad_account_id, campaign.meta_campaign_id)}
              target="_blank"
              rel="noreferrer"
            >
              Open in Ads Manager
            </a>
          )}
        </p>
      )}

      {lastBuild?.status === "failed" && lastBuild.error && !building && (
        <p role="alert" className="mt-2 whitespace-pre-line text-xs text-destructive">
          Last build failed: {lastBuild.error}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 text-xs text-brand-strong">
          {notice}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} onClick={() => setEditing(true)}>
          Budget and countries
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => void requestSheet()}
        >
          Write build sheet
        </button>
        <button type="button" className={buttonClass} onClick={() => setRecording(true)}>
          Record a hand build
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy || building}
          onClick={() => void request()}
        >
          {building ? "Building in Meta…" : campaign.meta_campaign_id ? "Build again (paused)" : "Build in Meta (paused)"}
        </button>
      </div>

      <FormModal
        open={editing}
        onClose={() => setEditing(false)}
        title={`Meta settings · ${campaign.name}`}
        fields={FIELDS}
        initialValues={initialValues}
        onSubmit={async (v) => {
          const budget = Number(v.daily_budget);
          if (!Number.isFinite(budget) || budget <= 0) throw new Error("The daily budget must be more than zero.");
          const countries = parseCountries(String(v.target_countries ?? ""));
          if ("problem" in countries) throw new Error(countries.problem);
          const { error: updateError } = await supabase
            .from("client_campaigns")
            .update({
              daily_budget: budget,
              target_countries: countries.codes,
              conversion_event: (v.conversion_event as string) || null,
            })
            .eq("id", campaign.id);
          if (updateError) throw new Error(updateError.message);
        }}
        onSaved={onChanged}
      />

      <FormModal
        open={recording}
        onClose={() => setRecording(false)}
        title={`Record a hand build · ${campaign.name}`}
        fields={HAND_BUILD_FIELDS}
        initialValues={handBuildValues}
        onSubmit={async (v) => {
          const campaignId = parseMetaObjectId(String(v.meta_campaign_id ?? ""), "campaign id");
          if ("problem" in campaignId) throw new Error(campaignId.problem);

          const adSetText = String(v.meta_ad_set_id ?? "").trim();
          let adSetId: string | null = null;
          if (adSetText) {
            const parsed = parseMetaObjectId(adSetText, "ad set id");
            if ("problem" in parsed) throw new Error(parsed.problem);
            adSetId = parsed.id;
          }

          const { error: updateError } = await supabase
            .from("client_campaigns")
            .update({
              meta_campaign_id: campaignId.id,
              meta_ad_set_id: adSetId,
              // What this column means is that the structure exists in the
              // account, which is as true of a hand build as of ours. Kept if
              // it is already set, so re-recording does not move the date.
              meta_built_at: campaign.meta_built_at ?? new Date().toISOString(),
            })
            .eq("id", campaign.id);
          if (updateError) {
            // The unique index on meta_campaign_id. Worth naming, because the
            // likeliest cause is the id belonging to a different console
            // campaign, and reporting would then credit the wrong one.
            if (updateError.code === "23505") {
              throw new Error("Another campaign in the console is already recorded as that Meta campaign.");
            }
            throw new Error(updateError.message);
          }
        }}
        onSaved={() => {
          setNotice(
            "Recorded. Reporting can now match the spend, and building in Meta will finish what is missing rather than starting again.",
          );
          onChanged();
        }}
      />
    </div>
  );
}
