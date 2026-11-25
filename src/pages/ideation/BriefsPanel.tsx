import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { FilterPills } from "../../components/FilterPills";
import { DataTable } from "../../components/DataTable";
import { ActionMenu } from "../../components/ActionMenu";
import { dayOrDash, deleteContentBrief, deletionSummary, setContentArchived, DELETE_BRIEF_WARNING } from "../../lib/contentRecords";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { mediaFilters } from "../../data/mediaFilters";
import type { MediaFilterId } from "../../data/mediaFilters";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { supabase } from "../../lib/supabase";
import { ApproveAndBuildModal } from "../../components/briefs/ApproveAndBuildModal";
import { BriefDetailModal } from "../../components/briefs/BriefDetailModal";
import { formatFilters, formatLabel } from "../../lib/contentFormat";
import { platformLabel } from "../../lib/postPlatform";
import type { FormatFilterId } from "../../lib/contentFormat";
import { FormModal } from "../../components/forms/FormModal";
import { FacelessReelStoryboard, type ReelPreview } from "../motion/FacelessReelStoryboard";
import { prepareReelCopy } from "./reelBriefCopy";
import { revisedBriefBody } from "./textBriefCopy";
import { ContentJourney } from "../../components/ContentJourney";

type Brief = {
  id: string;
  title: string;
  body: string | null;
  media_type: "image" | "text" | "video";
  content_format: string;
  format_code?: string | null;
  target_platform?: string | null;
  frame_plan?: string[] | null;
  frame_count: number | null;
  avatar_brief: string | null;
  editor_brief: string | null;
  shot_requirements: string | null;
  hook: string | null;
  call_to_action: string | null;
  production_method?: string | null;
  brief_ref: string | null;
  status: string;
  source_idea_id: string | null;
  created_at: string;
  updated_at: string;
  purpose: string;
  archived_at: string | null;
  proof_asset_id: string | null;
  excluded_artwork_proof_id: string | null;
  script: string | null;
  argument: string | null;
  visual_direction: string | null;
};

type ImageAttempt = { brief_id: string; job_id: string | null; asset_id: string | null };

type Assignment = {
  id: string;
  brief_id: string | null;
  stage: string;
  asset_id: string | null;
  team_members: { name: string } | null;
};

export function BriefsPanel({ stage = "brief", showJourney = true }: { stage?: "brief" | "create"; showJourney?: boolean } = {}) {
  const { clientId } = useParams<{ clientId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const focusedBrief = searchParams.get("brief");
  const [activeFilter, setActiveFilter] = useState<MediaFilterId>(mediaFilters[0].id);
  const [activeFormat, setActiveFormat] = useState<FormatFilterId>("all");
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [assignments, setAssignments] = useState<ReadonlyMap<string, Assignment[]>>(new Map());
  const [emailStatus, setEmailStatus] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [imageAttempts, setImageAttempts] = useState<ImageAttempt[]>([]);
  const [building, setBuilding] = useState<Brief | null>(null);
  const [editingCopy, setEditingCopy] = useState<Brief | null>(null);
  const [reelPreviews, setReelPreviews] = useState<ReelPreview[]>([]);
  const [editingReel, setEditingReel] = useState<{ brief: Brief; form: ReturnType<typeof prepareReelCopy> } | null>(null);
  const [viewing, setViewing] = useState<Brief | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The brief whose delete or archive is running, so its menu disables. */
  const [busyBrief, setBusyBrief] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      if (!clientId) {
        setLoading(false);
        return;
      }
      let query = supabase
        .from("client_briefs")
        .select(
          "id, title, body, avatar_brief, editor_brief, media_type, content_format, target_platform, format_code, frame_plan, frame_count, brief_ref, status, source_idea_id, created_at, updated_at, purpose, archived_at, hook, premise, argument, proof, script, visual_direction, shot_requirements, b_roll, call_to_action, channel_intent, production_method, proof_asset_id, excluded_artwork_proof_id",
        )
        .eq("client_id", clientId)
        .neq("purpose", "recruitment")
        .order("created_at", { ascending: false })
        .limit(100);
      // Asset creation archives the brief immediately. Create must still
      // show it while a reel renders or human footage is being returned.
      if (focusedBrief) query = query.eq("id", focusedBrief);
      else if (stage === "brief") query = query.is("archived_at", null);
      const { data, error } = await query;
      if (error) throw error;
      const rows = ((data ?? []) as Brief[]).filter(b => stage !== "brief" || !b.archived_at ||
        (b.id === focusedBrief && b.status === "complete" && b.excluded_artwork_proof_id));
      const briefIds = rows.map((row) => row.id);
      const [assigned, dispatches] = briefIds.length ? await Promise.all([
        supabase.from("job_assignments")
          .select("id, brief_id, stage, asset_id, team_members(name)")
          .in("brief_id", briefIds),
        supabase.from("brief_dispatches")
          .select("assignment_id, email_status")
          .in("brief_id", briefIds),
      ]) : [{ data: [], error: null }, { data: [], error: null }];
      if (assigned.error) throw assigned.error;
      if (dispatches.error) throw dispatches.error;
      const byBrief = new Map<string, Assignment[]>();
      for (const assignment of (assigned.data ?? []) as unknown as Assignment[]) {
        if (!assignment.brief_id) continue;
        byBrief.set(assignment.brief_id, [...(byBrief.get(assignment.brief_id) ?? []), assignment]);
      }
      if (rows.some(b => b.media_type === "video" && b.content_format === "reel")) {
        const result = await supabase.from("faceless_reel_previews_v1").select("*").eq("client_id",clientId);
        if (result.error) throw result.error;
        setReelPreviews(result.data ?? []);
      } else setReelPreviews([]);
      setBriefs(rows);
      setImageAttempts([]);
      if (rows.some(b => b.excluded_artwork_proof_id)) {
        const attempts = await supabase.rpc("reviewed_image_attempt_state", { p_client_id: clientId });
        if (!attempts.error) setImageAttempts(attempts.data ?? []);
      }
      setAssignments(byBrief);
      setEmailStatus(new Map((dispatches.data ?? [])
        .filter((row) => row.assignment_id)
        .map((row) => [row.assignment_id!, row.email_status])));
      setLoading(false);
    } catch (error) {
      setLoadError("Failed to load briefs: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    } finally {
      setLoading(false);
    }
  }, [clientId, stage, focusedBrief]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A brief appears minutes after the click that asked for it, so the page
  // has to reload itself when the job finishes rather than waiting to be
  // reloaded by hand.
  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  const activeLabel = mediaFilters.find((f) => f.id === activeFilter)?.label ?? "";
  const shown = briefs.filter(
    (b) => focusedBrief ? b.id === focusedBrief
      : b.media_type === activeFilter && (activeFormat === "all" || b.content_format === activeFormat),
  );
  const elsewhere = briefs.length - shown.length;

  async function queueImage(brief: Brief) {
    if (!clientId || busyBrief) return;
    setBusyBrief(brief.id);
    try {
      const { error } = await supabase.rpc("queue_reviewed_image_attempt", { p_client_id: clientId, p_brief_id: brief.id });
      if (error) throw error;
      setNotice("Image draft queued. Reopen this brief to view the result.");
    } catch {
      setNotice("Refresh this brief to check whether the image job was queued.");
    } finally {
      await refresh();
      setBusyBrief(null);
    }
  }

  function imageActions(brief: Brief) {
    const attempt = imageAttempts.find(row => row.brief_id === brief.id);
    if (attempt?.asset_id) return [{ label: "Open image draft", onSelect: () =>
      navigate(`/clients/${clientId}/delivery/content-production-factory?tab=create&draft=${attempt.asset_id}`) }];
    if (attempt && !attempt.job_id && brief.status === "draft" && !brief.archived_at)
      return [{ label: "Generate one image draft", onSelect: () => void queueImage(brief) }];
    return [];
  }

  async function excludeArtwork(brief: Brief) {
    if (!clientId || !brief.proof_asset_id || busyBrief) return;
    setBusyBrief(brief.id);
    try {
      const { error } = await supabase.rpc("exclude_brief_artwork_proof", {
        p_client_id: clientId, p_brief_id: brief.id, p_revision: brief.updated_at,
        p_proof_id: brief.proof_asset_id,
      });
      if (error) throw error;
      setNotice("Proof excluded from artwork. Image generation is held pending a verified spending ceiling.");
      await refresh();
    } catch (error) {
      setNotice((error as { message?: string }).message ?? "Could not update the artwork source.");
    } finally {
      setBusyBrief(null);
    }
  }

  async function archiveBrief(brief: Brief) {
    if (busyBrief) return;
    setBusyBrief(brief.id);
    setNotice(null);
    try {
      await setContentArchived("brief", brief.id);
      setNotice("Archived. It is still in the Archive, under Briefs.");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setBusyBrief(null);
    }
  }

  async function deleteBrief(brief: Brief) {
    if (busyBrief || !window.confirm(DELETE_BRIEF_WARNING)) return;
    setBusyBrief(brief.id);
    setNotice(null);
    try {
      setNotice(deletionSummary(await deleteContentBrief(brief.id)));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setBusyBrief(null);
    }
  }

  /**
   * Where a finished brief's asset lives.
   *
   * That is Create until somebody signs it off, not Assets: Assets is only
   * what has been approved for distribution.
   */
  function deliveryHref(): string {
    return `/clients/${clientId}/delivery/content-production-factory?tab=create`;
  }

  const pilot = reelPreviews.find(p => p.client_id === clientId && p.brief_id === focusedBrief);
  const pilotBrief = briefs.find(b => b.id === pilot?.brief_id);
  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

  return (
    <div>
      {showJourney && <ContentJourney clientId={clientId} current={stage} briefId={focusedBrief} />}
      {pilot && pilotBrief && <FacelessReelStoryboard key={pilot.brief_id} preview={pilot} updatedAt={pilotBrief.updated_at} reload={refresh} />}
      {stage === "create" && !pilot && <p className="mb-4 text-sm text-muted-foreground">
        Choose a brief to create with AI or assign to a person. Track generated reels in Media → Reel shots and returned footage in Edit / Repurpose.
      </p>}
      <AgentActivityBar inFlight={inFlight} failures={recentFailures} />

      {focusedBrief ? (
        <p className="mb-4 text-xs text-muted-foreground">
          Following one brief from its production view.{" "}
          <button type="button" className="font-medium text-brand-strong hover:underline"
            onClick={() => setSearchParams((current) => {
              const next = new URLSearchParams(current);
              next.delete("brief");
              if (stage === "brief") next.set("tab", "briefs");
              return next;
            })}>Show all briefs</button>
        </p>
      ) : (
        <div className="mb-4 flex flex-col gap-2">
          <FilterPills options={mediaFilters} activeId={activeFilter} onChange={setActiveFilter} />
          <FilterPills options={formatFilters} activeId={activeFormat} onChange={setActiveFormat} />
        </div>
      )}
      {notice && (
        <p role="status" className="mb-4 text-sm text-brand-strong">
          {notice}
        </p>
      )}

      <DataTable
        columns={["Brief", "Destination", "Format", "Type", "Brief created at", "Actions"]}
        emptyLabel={
          loading
            ? "Loading briefs…"
            : elsewhere > 0
              // "No image briefs" while three video briefs sit one pill away
              // reads as "nothing worked". Say where they actually are.
              ? `No ${activeLabel.toLowerCase()} briefs — ${elsewhere} brief${elsewhere === 1 ? "" : "s"} under another type`
              : stage === "create" ? "No briefs ready to create yet — brief an idea first" : "No briefs yet — approve an idea on the Generation tab"
        }
        rows={shown.map((b) => [
          <button
            key="t"
            type="button"
            onClick={() => setViewing(b)}
            className="rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {b.title}
            {b.excluded_artwork_proof_id && <span className="block text-xs text-muted-foreground">{imageAttempts.some(row => row.brief_id === b.id) ? "Independent artwork" : "Independent artwork · generation held"}</span>}
            {b.brief_ref && <span className="block text-xs text-muted-foreground">{b.brief_ref}</span>}
            {(assignments.get(b.id) ?? []).map((assignment) => (
              <span key={assignment.id} className="block text-xs text-muted-foreground">
                {assignment.team_members?.name ?? "Team member"}: {assignment.stage.replace(/_/g, " ")}
                {emailStatus.get(assignment.id) === "skipped" ? " · assigned, email not sent" : ""}
                {emailStatus.get(assignment.id) === "failed" ? " · email failed" : ""}
              </span>
            ))}
          </button>,
          <span key="p">{platformLabel(b.target_platform)}</span>,
          <span key="f">{formatLabel(b.content_format)}</span>,
          <span key="m" className="capitalize">{b.media_type}</span>,
          <span key="c">{dayOrDash(b.created_at)}</span>,
          // Forward action first, then the ways of looking at it, then
          // archive, then delete. A brief already in production has been
          // actioned: offering Build again would quietly queue a second one.
          <ActionMenu
            key={`a-${b.id}`}
            name={b.title}
            busy={busyBrief === b.id}
            items={[
              ...imageActions(b),
              ...(reelPreviews.some(p => p.client_id === clientId && p.brief_id === b.id)
                ? [{ label: "Open motion storyboard", onSelect: () => navigate(`/clients/${clientId}/delivery/content-production-factory?tab=briefs&brief=${b.id}`) }]
                : b.status === "in_production" || b.status === "complete"
                ? b.media_type === "video" && b.content_format === "reel"
                  ? [{
                      label: "Track reel",
                      onSelect: () => navigate(`/clients/${clientId}/delivery/content-production-factory?tab=assets&library=reel-shots&brief=${b.id}`),
                    }]
                  : (assignments.get(b.id) ?? []).some((assignment) => assignment.asset_id)
                    ? [{ label: "View delivery", onSelect: () => navigate(deliveryHref()) }]
                    : []
                : b.excluded_artwork_proof_id ? [] : [{ label: "Approve & build", onSelect: () => setBuilding(b) }]),
              ...(b.media_type === "video" && b.status === "approved" && !reelPreviews.some(p => p.brief_id === b.id)
                ? [{ label: "Start code video from brief",
                  onSelect: () => navigate(`/clients/${clientId}/delivery/content-production-factory?tab=generation&videoBrief=${b.id}`) }]
                : []),
              ...(b.purpose === "client" && !b.archived_at && (b.media_type === "text" || (b.media_type === "image" && b.content_format === "single" && b.visual_direction)) && b.status === "draft" && b.script && b.argument && b.body
                ? [{ label: "Edit draft copy", onSelect: () => setEditingCopy(b) }] : []),
              ...(b.status === "draft" && b.purpose === "client" && b.media_type === "image"
                && b.content_format === "single" && !b.archived_at && b.proof_asset_id
                && !assignments.has(b.id)
                ? [{ label: "Exclude proof from artwork", onSelect: () => void excludeArtwork(b) }] : []),
              ...(b.purpose === "client" && b.status === "draft" && !b.archived_at && !assignments.has(b.id)
                && b.media_type === "video" && b.content_format === "reel" && (b.format_code === "F6" || b.format_code === "F7")
                ? [{ label: "Edit draft reel", onSelect: () => {
                  try { setEditingReel({ brief: b, form: prepareReelCopy(b) }); }
                  catch (error) { setNotice(error instanceof Error ? error.message : "The reel could not be opened for editing."); }
                } }] : []),
              { label: "View brief", onSelect: () => setViewing(b) },
              { label: "Archive", busyLabel: "Archiving…", onSelect: () => void archiveBrief(b) },
              { label: "Delete", destructive: true, busyLabel: "Deleting…", onSelect: () => void deleteBrief(b) },
            ]}
          />,
        ])}
      />

      {editingReel && <FormModal open title="Edit draft reel" submitLabel="Save reel brief"
        fields={editingReel.form.fields} initialValues={editingReel.form.initialValues}
        onClose={() => setEditingReel(null)}
        onSubmit={async values => {
          if (!clientId) throw new Error("Select a client before editing.");
          const { data: brand, error: brandError } = await supabase.from("client_brand_profiles")
            .select("never_do, colour_primary, colour_secondary, colour_accent, colour_background, colour_text")
            .eq("client_id", clientId).maybeSingle();
          if (brandError) throw new Error(brandError.message);
          const palette = brand ? [brand.colour_primary, brand.colour_secondary, brand.colour_accent,
            brand.colour_background, brand.colour_text].filter((colour): colour is string => !!colour) : null;
          const patch = editingReel.form.revision(values, brand?.never_do ?? "", palette);
          const { data, error } = await supabase.from("client_briefs").update(patch)
            .eq("client_id", clientId).eq("id", editingReel.brief.id).eq("updated_at", editingReel.brief.updated_at)
            .eq("purpose", "client").eq("media_type", "video").eq("content_format", "reel")
            .eq("status", "draft").is("archived_at", null).select("id").maybeSingle();
          if (error) throw new Error(error.message);
          if (!data) throw new Error("The reel changed or is unavailable for editing. Refresh before saving.");
        }}
        onSaved={() => { setNotice("Reel brief saved."); void refresh(); }}
      />}

      {editingCopy && <FormModal
        open title="Edit draft copy" submitLabel="Save brief"
        fields={[
          { name: "argument", label: "Argument", kind: "textarea", rows: 6, required: true },
          { name: "script", label: "Script", kind: "textarea", rows: 8, required: true },
          ...(editingCopy.media_type === "image" ? [{ name: "visual_direction", label: "Visual direction", kind: "textarea" as const, rows: 6, required: true }] : []),
        ]}
        initialValues={{ argument: editingCopy.argument ?? "", script: editingCopy.script ?? "", visual_direction: editingCopy.visual_direction ?? "" }}
        onClose={() => setEditingCopy(null)}
        onSubmit={async values => {
          if (!clientId || !editingCopy.body || !editingCopy.script || !editingCopy.argument) {
            throw new Error("The source brief is unavailable.");
          }
          const image = editingCopy.media_type === "image";
          const copy = {
            argument: String(values.argument), script: String(values.script),
            ...(image ? { visual_direction: String(values.visual_direction) } : {}),
          };
          const body = revisedBriefBody(editingCopy.body, {
            script: editingCopy.script, argument: editingCopy.argument,
            ...(image ? { visual_direction: editingCopy.visual_direction ?? "" } : {}),
          }, copy);
          const { data, error } = await supabase.from("client_briefs").update({ ...copy, body })
            .eq("client_id", clientId).eq("id", editingCopy.id).eq("updated_at", editingCopy.updated_at)
            .eq("purpose", "client").eq("media_type", editingCopy.media_type).eq("status", "draft").is("archived_at", null)
            .select("id").maybeSingle();
          if (error) throw new Error(error.message);
          if (!data) throw new Error("The brief changed or is unavailable for editing. Refresh before saving.");
        }}
        onSaved={() => { setNotice("Brief saved."); void refresh(); }}
      />}

      <BriefDetailModal brief={viewing} open={viewing !== null} onClose={() => setViewing(null)} />

      <ApproveAndBuildModal
        brief={building}
        open={building !== null}
        onClose={() => setBuilding(null)}
        onDone={(route) => {
          setNotice(route === "ai" && building?.media_type === "text"
            ? "Draft queued. When the build finishes, open Create and select Text to review the draft."
            : "Queued. Follow generated reels under Media → Reel shots. Human assignments appear on the recipient dashboard; email depends on Resend configuration.",
          );
          void refresh();
        }}
      />
    </div>
  );
}
