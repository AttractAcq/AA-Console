import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { PenLine, Sparkles, BadgeCheck } from "lucide-react";
import { ActionCard } from "../../components/ActionCard";
import { FilterPills } from "../../components/FilterPills";
import { DataTable } from "../../components/DataTable";
import { FormModal, ConfirmModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { MEDIA_TYPE_OPTIONS, loadProofAssets, useOptions } from "../../lib/options";
import { mediaFilters } from "../../data/mediaFilters";
import type { MediaFilterId } from "../../data/mediaFilters";
import { supabase } from "../../lib/supabase";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import type { Database } from "../../types/database";

type MediaType = Database["public"]["Enums"]["media_type"];

type Idea = {
  id: string;
  title: string;
  media_type: string;
  source: string;
  status: string;
};

const MANUAL_FIELDS: FieldDef[] = [
  { name: "title", label: "Idea", kind: "text", required: true },
  { name: "media_type", label: "Media type", kind: "select", options: MEDIA_TYPE_OPTIONS },
  { name: "body", label: "Detail", kind: "textarea", rows: 3 },
];

export function GenerationPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<MediaFilterId>(mediaFilters[0].id);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [busyIdeaId, setBusyIdeaId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const proofOptions = useOptions(
    () => loadProofAssets(clientId ?? ""),
    openCardId === "proof-idea" && Boolean(clientId),
    [clientId],
  );

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("client_ideas")
      .select("id, title, media_type, source, status")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });
    setIdeas((data ?? []) as Idea[]);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  const activeLabel = mediaFilters.find((f) => f.id === activeFilter)?.label ?? "";
  const shown = ideas.filter((i) => i.media_type === activeFilter);

  async function approveAndBrief(ideaId: string) {
    setBusyIdeaId(ideaId);
    setNotice(null);
    const { error } = await supabase.rpc("approve_idea_and_generate_brief", { p_idea_id: ideaId });
    setBusyIdeaId(null);
    // Previously this swallowed the error: a failed approve did nothing at
    // all and looked identical to a successful one.
    if (error) {
      setNotice({ kind: "error", text: error.message });
      return;
    }
    setNotice({
      kind: "ok",
      text: "Approved. The brief agent is writing it now — this takes a couple of minutes and the Briefs tab will fill in on its own.",
    });
    void refresh();
  }

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
      </div>

      <div className="mb-4">
        <FilterPills options={mediaFilters} activeId={activeFilter} onChange={setActiveFilter} />
      </div>
      <DataTable
        columns={["Idea", "Type", "Status", ""]}
        emptyLabel={`No ${activeLabel.toLowerCase()} ideas yet`}
        rows={shown.map((i) => [
          i.title,
          i.source,
          i.status,
          i.status === "draft" ? (
            <button
              key={i.id}
              type="button"
              disabled={busyIdeaId === i.id}
              onClick={() => void approveAndBrief(i.id)}
              className="text-sm text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {busyIdeaId === i.id ? "Queueing…" : "Approve & brief"}
            </button>
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
          const { error } = await supabase.from("client_ideas").insert({
            client_id: clientId,
            title: (v.title as string).trim(),
            body: (v.body as string)?.trim() || null,
            media_type: ((v.media_type as string) || "image") as MediaType,
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
