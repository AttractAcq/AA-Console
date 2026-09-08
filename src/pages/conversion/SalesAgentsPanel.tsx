import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";

type QualificationStep = {
  question: string;
  why: string;
  good_answer: string;
  disqualifier: string;
};

type Objection = { objection: string; response: string };

type SalesAgent = {
  id: string;
  name: string;
  purpose: string;
  status: string;
  page_id: string | null;
  greeting: string | null;
  system_prompt: string | null;
  qualification: QualificationStep[] | null;
  objections: Objection[] | null;
  booking_rule: string | null;
  escalation_rule: string | null;
  guardrails: string | null;
  built_at: string | null;
  created_at: string;
};

type PageOption = { id: string; title: string };

type Stats = { conversations: number; captured: number; qualified: number };

const STATUS_TONE: Record<string, string> = {
  draft: "bg-secondary text-secondary-foreground",
  live: "bg-primary/10 text-brand-strong",
  retired: "bg-muted text-muted-foreground",
};

export function SalesAgentsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [agents, setAgents] = useState<SalesAgent[]>([]);
  const [pages, setPages] = useState<PageOption[]>([]);
  const [stats, setStats] = useState<Record<string, Stats>>({});
  const [buildOpen, setBuildOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    const [agentRes, pageRes, convRes] = await Promise.all([
      supabase
        .from("client_sales_agents")
        .select(
          "id, name, purpose, status, page_id, greeting, system_prompt, qualification, objections, booking_rule, escalation_rule, guardrails, built_at, created_at",
        )
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      supabase
        .from("client_pages")
        .select("id, title")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      supabase
        .from("sales_agent_conversations")
        .select("sales_agent_id, qualified, lead_id")
        .eq("client_id", clientId),
    ]);

    setAgents((agentRes.data ?? []) as SalesAgent[]);
    setPages((pageRes.data ?? []) as PageOption[]);

    const tally: Record<string, Stats> = {};
    for (const c of (convRes.data ?? []) as {
      sales_agent_id: string;
      qualified: boolean;
      lead_id: string | null;
    }[]) {
      const s = (tally[c.sales_agent_id] ??= { conversations: 0, captured: 0, qualified: 0 });
      s.conversations += 1;
      if (c.lead_id) s.captured += 1;
      if (c.qualified) s.qualified += 1;
    }
    setStats(tally);
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The definition appears a minute or two after the click that asked for it.
  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  const open = agents.find((a) => a.id === openId);

  const fields: FieldDef[] = [
    { name: "name", label: "Agent name", kind: "text", required: true },
    {
      name: "purpose",
      label: "What this agent is for",
      kind: "textarea",
      rows: 4,
      required: true,
      hint: "It is built from this plus your offer strategy, ICP, brand voice and whatever proof is cleared for use.",
    },
    {
      name: "page_id",
      label: "Page it lives on",
      kind: "select",
      options: [
        { value: "", label: "Not attached to a page yet" },
        ...pages.map((p) => ({ value: p.id, label: p.title })),
      ],
    },
  ];

  return (
    <div>
      <AgentActivityBar inFlight={inFlight} failures={recentFailures} />

      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setBuildOpen(true)}>
          Build Sales Agent
        </Button>
      </div>

      {notice && (
        <p role="status" className="mb-4 text-sm text-brand-strong">
          {notice}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : agents.length === 0 ? (
        <EmptyState label="No sales agents built yet" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => {
            const s = stats[a.id];
            const questions = a.qualification?.length ?? 0;
            return (
              <Panel key={a.id} title={a.name}>
                <span
                  className={cn(
                    "inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                    STATUS_TONE[a.status] ?? "bg-muted text-muted-foreground",
                  )}
                >
                  {a.status}
                </span>

                {a.built_at ? (
                  <>
                    <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{a.greeting}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {questions} qualification question{questions === 1 ? "" : "s"} ·{" "}
                      {a.objections?.length ?? 0} objection{(a.objections?.length ?? 0) === 1 ? "" : "s"} handled
                    </p>
                    <button
                      type="button"
                      onClick={() => setOpenId(a.id)}
                      className="mt-2 rounded text-sm font-medium text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Read the agent
                    </button>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Waiting for the agent to build this.
                  </p>
                )}

                {/* Conversations are the only thing that says whether the
                    script works. Silence is worth showing as silence. */}
                <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
                  {s
                    ? `${s.conversations} conversation${s.conversations === 1 ? "" : "s"} · ${s.captured} became leads · ${s.qualified} qualified`
                    : "No conversations yet"}
                </p>
              </Panel>
            );
          })}
        </div>
      )}

      <FormModal
        open={buildOpen}
        onClose={() => setBuildOpen(false)}
        title="Build Sales Agent"
        draftKey={`sales-agent:${clientId}`}
        intro="Queues the Sales Agent Builder. It needs your offer strategy and ICP, takes a couple of minutes, and this page fills in on its own when it finishes."
        fields={fields}
        submitLabel="Build"
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const pageId = (v.page_id as string) || null;
          const { data, error } = await supabase
            .from("client_sales_agents")
            .insert({
              client_id: clientId,
              name: (v.name as string).trim(),
              purpose: (v.purpose as string).trim(),
              page_id: pageId,
            })
            .select("id")
            .single();
          if (error) throw error;

          const { error: jobError } = await supabase.rpc("enqueue_agent_job", {
            p_agent_key: "sales_agent",
            p_client_id: clientId,
            p_input_table: "client_sales_agents",
            p_input_id: data.id,
          });
          if (jobError) throw new Error(jobError.message);
          setNotice("Queued. The builder is writing the agent now.");
        }}
        onSaved={refresh}
      />

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setOpenId(null)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={open.name}
            className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold text-card-foreground">{open.name}</h2>
              <button
                type="button"
                onClick={() => setOpenId(null)}
                className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Close
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
              <section>
                <h3 className="text-sm font-semibold text-foreground">Opens with</h3>
                <p className="mt-1 text-sm text-muted-foreground">{open.greeting}</p>
              </section>

              {/* Guardrails lead, above everything else it will say. This is
                  the section that decides whether the agent is safe to put in
                  front of a client's customers, so it is not buried under the
                  script. */}
              <section>
                <h3 className="text-sm font-semibold text-destructive">Never says</h3>
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                  {open.guardrails}
                </p>
              </section>

              <section>
                <h3 className="text-sm font-semibold text-foreground">Qualification</h3>
                <ol className="mt-2 space-y-3">
                  {(open.qualification ?? []).map((q, i) => (
                    <li key={i} className="rounded-lg border border-border p-3">
                      <p className="text-sm font-medium text-card-foreground">
                        {i + 1}. {q.question}
                      </p>
                      {q.why && <p className="mt-1 text-xs text-muted-foreground">Establishes: {q.why}</p>}
                      {q.disqualifier && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Not a fit if: {q.disqualifier}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              </section>

              {(open.objections ?? []).length > 0 && (
                <section>
                  <h3 className="text-sm font-semibold text-foreground">Objections</h3>
                  <dl className="mt-2 space-y-2">
                    {(open.objections ?? []).map((o, i) => (
                      <div key={i}>
                        <dt className="text-sm font-medium text-card-foreground">{o.objection}</dt>
                        <dd className="text-sm text-muted-foreground">{o.response}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}

              <section>
                <h3 className="text-sm font-semibold text-foreground">Books when</h3>
                <p className="mt-1 text-sm text-muted-foreground">{open.booking_rule}</p>
              </section>

              <section>
                <h3 className="text-sm font-semibold text-foreground">Hands over to a person when</h3>
                <p className="mt-1 text-sm text-muted-foreground">{open.escalation_rule}</p>
              </section>

              <section>
                <h3 className="text-sm font-semibold text-foreground">Operating instructions</h3>
                <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                  {open.system_prompt}
                </pre>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
