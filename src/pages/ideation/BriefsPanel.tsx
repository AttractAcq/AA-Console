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
  production_method?: string | null;
  brief_ref: string | null;
  status: string;
  source_idea_id: string | null;
  created_at: string;
};

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
  const [building, setBuilding] = useState<Brief | null>(null);
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
          "id, title, body, avatar_brief, editor_brief, media_type, content_format, target_platform, format_code, frame_plan, brief_ref, status, source_idea_id, created_at, hook, premise, argument, proof, script, visual_direction, shot_requirements, b_roll, call_to_action, channel_intent, production_method, proof_asset_id",
        )
        .eq("client_id", clientId)
        .neq("purpose", "recruitment")
        .order("created_at", { ascending: false })
        .limit(100);
      // Asset creation archives the brief immediately. Create must still
      // show it while a reel renders or human footage is being returned.
      if (stage === "brief") query = query.is("archived_at", null);
      const { data, error } = await query;
      if (error) throw error;
      const rows = (data ?? []) as Brief[];
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
      setBriefs(rows);
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
  }, [clientId, stage]);

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

  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

  return (
    <div>
      {showJourney && <ContentJourney clientId={clientId} current={stage} briefId={focusedBrief} />}
      {stage === "create" && <p className="mb-4 text-sm text-muted-foreground">
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
              ...(b.status === "in_production" || b.status === "complete"
                ? b.media_type === "video" && b.content_format === "reel"
                  ? [{
                      label: "Track reel",
                      onSelect: () => navigate(`/clients/${clientId}/delivery/content-production-factory?tab=assets&library=reel-shots&brief=${b.id}`),
                    }]
                  : (assignments.get(b.id) ?? []).some((assignment) => assignment.asset_id)
                    ? [{ label: "View delivery", onSelect: () => navigate(deliveryHref()) }]
                    : []
                : [{ label: "Approve & build", onSelect: () => setBuilding(b) }]),
              { label: "View brief", onSelect: () => setViewing(b) },
              { label: "Archive", busyLabel: "Archiving…", onSelect: () => void archiveBrief(b) },
              { label: "Delete", destructive: true, busyLabel: "Deleting…", onSelect: () => void deleteBrief(b) },
            ]}
          />,
        ])}
      />

      <BriefDetailModal brief={viewing} open={viewing !== null} onClose={() => setViewing(null)} />

      <ApproveAndBuildModal
        brief={building}
        open={building !== null}
        onClose={() => setBuilding(null)}
        onDone={() => {
          setNotice(
            "Queued. Follow generated reels under Media → Reel shots. Human assignments appear on the recipient dashboard; email depends on Resend configuration.",
          );
          void refresh();
        }}
      />
    </div>
  );
}
