import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { PenLine, Sparkles, BadgeCheck, Columns3 } from "lucide-react";
import { ActionCard } from "../../components/ActionCard";
import { FilterPills } from "../../components/FilterPills";
import { DataTable } from "../../components/DataTable";
import { FormModal, ConfirmModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { CONTENT_FORMAT_OPTIONS, MEDIA_TYPE_OPTIONS, loadContentPillars, loadProofAssets, useOptions } from "../../lib/options";
import { mediaFilters } from "../../data/mediaFilters";
import type { MediaFilterId } from "../../data/mediaFilters";
import { formatFilters, formatAllows, formatLabel } from "../../lib/contentFormat";
import type { FormatFilterId } from "../../lib/contentFormat";
import { supabase } from "../../lib/supabase";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import type { Database } from "../../types/database";

type MediaType = Database["public"]["Enums"]["media_type"];
type ContentFormatValue = Database["public"]["Enums"]["content_format"];

type Idea = {
  id: string;
  title: string;
  media_type: string;
  content_format: string;
  source: string;
  status: string;
};

const MANUAL_FIELDS: FieldDef[] = [
  { name: "title", label: "Idea", kind: "text", required: true },
  { name: "media_type", label: "Media type", kind: "select", options: MEDIA_TYPE_OPTIONS },
  // Hidden for text, which has no shape other than single. Shown for image
  // and video, where the options differ — a carousel is images only — so the
  // pairing is checked on submit rather than by narrowing the list here.
  {
    name: "content_format",
    label: "Format",
    kind: "select",
    options: CONTENT_FORMAT_OPTIONS,
    showIf: { field: "media_type", equals: ["image", "video"] },
    hint: "Carousel and story are made of ordered frames. A carousel is images only.",
  },
  { name: "body", label: "Detail", kind: "textarea", rows: 3 },
];

export function GenerationPanel({ watchJobs = true, refreshToken }: { watchJobs?: boolean; refreshToken?: unknown } = {}) {
  const { clientId } = useParams<{ clientId: string }>();
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<MediaFilterId>(mediaFilters[0].id);
  const [activeFormat, setActiveFormat] = useState<FormatFilterId>("all");
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [busyAction, setBusyAction] = useState<{ ideaId: string; action: "approve" | "brief" | "approve-and-brief" } | null>(null);
  const actionInFlight = useRef(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const proofOptions = useOptions(
    () => loadProofAssets(clientId ?? ""),
    openCardId === "proof-idea" && Boolean(clientId),
    [clientId],
  );
  const pillarOptions = useOptions(
    () => loadContentPillars(clientId ?? ""),
    openCardId === "pillar-idea" && Boolean(clientId),
    [clientId],
  );

  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      if (!clientId) return;
      const { data, error } = await supabase
        .from("client_ideas")
        .select("id, title, media_type, content_format, source, status")
        .eq("client_id", clientId)
        // An idea whose brief exists is record, not work. It lives in the
        // archive from that moment; leaving it here is how 300 drafts and 33
        // finished ideas became one indistinguishable list.
        .is("archived_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      setIdeas((data ?? []) as Idea[]);
    } catch (error) {
      setLoadError("Failed to load ideas: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  const { inFlight, recentFailures } = useAgentJobs(watchJobs ? clientId : undefined, refresh);

  const activeLabel = mediaFilters.find((f) => f.id === activeFilter)?.label ?? "";
  const shown = ideas.filter(
    (i) => i.media_type === activeFilter && (activeFormat === "all" || i.content_format === activeFormat),
  );

  async function actOnIdea(ideaId: string, action: "approve" | "brief" | "approve-and-brief") {
    if (!clientId || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusyAction({ ideaId, action });
    setNotice(null);
    try {
      if (action === "approve") {
        const { data, error } = await supabase
          .from("client_ideas")
          .update({ status: "approved" })
          .eq("id", ideaId)
          .eq("client_id", clientId)
          .eq("status", "draft")
          .select("id")
          .single();
        if (error) throw error;
        if (!data) throw new Error("This idea is no longer a draft. Refresh and try again.");
        setNotice({ kind: "ok", text: "Idea approved." });
      } else {
        const { error } = await supabase.rpc("approve_idea_and_generate_brief", { p_idea_id: ideaId });
        if (error) throw error;
        setNotice({
          kind: "ok",
          text: `${action === "brief" ? "Brief queued." : "Approved."} The brief agent is writing it now — this takes a couple of minutes and the Briefs tab will fill in on its own.`,
        });
      }
      await refresh();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : (error as { message?: string }).message ?? "Something went wrong." });
    } finally {
      actionInFlight.current = false;
      setBusyAction(null);
    }
  }

  const pillarFields: FieldDef[] = [
    {
      name: "pillar_id",
      label: "Pillar",
      kind: "select",
      required: true,
      options: pillarOptions,
      hint:
        pillarOptions.length === 0
          ? "This client has no active content pillars yet. Define them under Strategy first."
          : "Every idea in the run will sit inside this pillar, including the ones that would be better somewhere else.",
    },
  ];

  const proofFields: FieldDef[] = [
    {
      name: "proof_id",
      label: "Seed from proof",
      kind: "select",
      required: true,
      options: proofOptions,
      hint: "Proof Bank has no writer in the admin console yet — add proof from the Client console.",
    },
  ];

  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

  return (
    <div>
      <AgentActivityBar inFlight={inFlight} failures={recentFailures} />

      {notice && (
        <p
          role="status"
          className={`mb-4 text-sm ${notice.kind === "ok" ? "text-brand-strong" : "text-destructive"}`}
        >
          {notice.text}
        </p>
      )}

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <ActionCard title="Manual Idea" icon={PenLine} onClick={() => setOpenCardId("manual-idea")} />
        <ActionCard title="Auto Idea" icon={Sparkles} onClick={() => setOpenCardId("auto-idea")} />
        <ActionCard title="Proof Idea" icon={BadgeCheck} onClick={() => setOpenCardId("proof-idea")} />
        <ActionCard title="Pillar Idea" icon={Columns3} onClick={() => setOpenCardId("pillar-idea")} />
      </div>

      <div className="mb-4 flex flex-col gap-2">
        <FilterPills options={mediaFilters} activeId={activeFilter} onChange={setActiveFilter} />
        {/* A second axis, not more of the first: an idea is an image AND a
            carousel. Pills rather than a column alone so "show me the
            carousels" is one click. */}
        <FilterPills options={formatFilters} activeId={activeFormat} onChange={setActiveFormat} />
      </div>
      <DataTable
        columns={["Idea", "Format", "Type", "Status", ""]}
        emptyLabel={`No ${activeLabel.toLowerCase()} ideas yet`}
        rows={shown.map((i) => [
          i.title,
          formatLabel(i.content_format),
          i.source,
          i.status,
          i.status === "draft" || i.status === "approved" ? (
            <span key={i.id} className="inline-flex items-center gap-3">
              {i.status === "draft" && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void actOnIdea(i.id, "approve")}
                  className="text-sm text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {busyAction?.ideaId === i.id && busyAction.action === "approve" ? "Approving…" : "Approve"}
                </button>
              )}
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void actOnIdea(i.id, i.status === "draft" ? "approve-and-brief" : "brief")}
                className="text-sm text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {busyAction?.ideaId === i.id && busyAction.action !== "approve"
                  ? "Queueing…" : i.status === "draft" ? "Approve & brief" : "Brief"}
              </button>
            </span>
          ) : (
            "—"
          ),
        ])}
      />

      <FormModal
        open={openCardId === "manual-idea"}
        onClose={() => setOpenCardId(null)}
        title="Manual Idea"
        draftKey={`idea-manual:${clientId}`}
        fields={MANUAL_FIELDS}
        submitLabel="Add idea"
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const mediaType = ((v.media_type as string) || "image") as MediaType;
          // Text has no format field on the form, so it arrives blank and is
          // a single. The check is here as well as in the database because
          // the message a person reads should say which pairing is wrong,
          // not quote a constraint name at them.
          const format = (mediaType === "text" ? "single" : (v.content_format as string) || "single") as ContentFormatValue;
          if (!formatAllows(format, mediaType)) {
            throw new Error(`A ${formatLabel(format).toLowerCase()} cannot be ${mediaType}. Change one of the two.`);
          }
          const { error } = await supabase.from("client_ideas").insert({
            client_id: clientId,
            title: (v.title as string).trim(),
            body: (v.body as string)?.trim() || null,
            media_type: mediaType,
            content_format: format,
            source: "manual",
          });
          if (error) throw error;
        }}
        onSaved={refresh}
      />

      <ConfirmModal
        open={openCardId === "auto-idea"}
        onClose={() => setOpenCardId(null)}
        title="Auto Idea"
        body="Queues the Ideation agent. It reads your ICP question universe, brand strategy and proof bank — no input needed. It will refuse to run until those exist."
        confirmLabel="Run agent"
        onConfirm={async () => {
          if (!clientId) throw new Error("No client selected.");
          const { error } = await supabase.rpc("enqueue_agent_job", {
            p_agent_key: "ideation",
            p_client_id: clientId,
          });
          if (error) throw new Error(error.message);
        }}
        onDone={refresh}
      />

      <FormModal
        open={openCardId === "pillar-idea"}
        onClose={() => setOpenCardId(null)}
        title="Pillar Idea"
        draftKey={`idea-pillar:${clientId}`}
        intro="Queues the Ideation agent confined to one content pillar. An unscoped run fills the bank; this one fills a pillar."
        fields={pillarFields}
        submitLabel="Run agent"
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const { error } = await supabase.rpc("enqueue_agent_job", {
            p_agent_key: "ideation",
            p_client_id: clientId,
            p_input_table: "client_content_pillars",
            p_input_id: v.pillar_id as string,
          });
          if (error) throw new Error(error.message);
        }}
        onSaved={refresh}
      />

      <FormModal
        open={openCardId === "proof-idea"}
        onClose={() => setOpenCardId(null)}
        title="Proof Idea"
        draftKey={`idea-proof:${clientId}`}
        intro="Queues the Ideation agent seeded from one piece of proof."
        fields={proofFields}
        submitLabel="Run agent"
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const { error } = await supabase.rpc("enqueue_agent_job", {
            p_agent_key: "ideation",
            p_client_id: clientId,
            p_input_table: "client_proof_assets",
            p_input_id: v.proof_id as string,
          });
          if (error) throw new Error(error.message);
        }}
        onSaved={refresh}
      />
    </div>
  );
}
