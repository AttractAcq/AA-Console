import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";
import { liveStateOf, sinceLabel, STATE_TONE } from "./liveState";

type QualificationStep = {
  question: string;
  why: string;
  good_answer: string;
  disqualifier: string;
};

type Objection = { objection: string; response: string };

const ROLE_LABEL: Record<string, string> = {
  inbound_qualifier: "Inbound qualifier",
  appointment_setter: "Appointment setter",
  nurture: "Nurture",
  reactivation: "Reactivation",
  closer_assist: "Closer assist",
};

type SalesAgent = {
  id: string;
  name: string;
  purpose: string;
  status: string;
  role: string | null;
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

type Conversation = {
  id: string;
  sales_agent_id: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  qualified: boolean;
  handed_over: boolean;
  outcome: string | null;
  lead_id: string | null;
  started_at: string;
};

type PageOption = { id: string; title: string };

export function SalesOverviewPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [agents, setAgents] = useState<SalesAgent[]>([]);
  const [pages, setPages] = useState<PageOption[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [builds, setBuilds] = useState<Record<string, { status: string }>>({});
  const [buildOpen, setBuildOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    const [agentRes, pageRes, convRes, jobRes] = await Promise.all([
      supabase
        .from("client_sales_agents")
        .select(
          "id, name, purpose, status, role, page_id, greeting, system_prompt, qualification, objections, booking_rule, escalation_rule, guardrails, built_at, created_at",
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
        .select(
          "id, sales_agent_id, contact_name, contact_email, contact_phone, qualified, handed_over, outcome, lead_id, started_at",
        )
        .eq("client_id", clientId)
        .order("started_at", { ascending: false }),
      // Build jobs carry input_id, so each card can speak for its own agent.
      // useAgentJobs is client-wide and has no input_id, which would put
      // "Building…" on whichever card happened to render.
      supabase
        .from("agent_jobs")
        .select("status, input_id, created_at")
        .eq("client_id", clientId)
        .eq("agent_key", "sales_agent")
        .order("created_at", { ascending: false }),
    ]);

    setAgents((agentRes.data ?? []) as SalesAgent[]);
    setPages((pageRes.data ?? []) as PageOption[]);
    setConversations((convRes.data ?? []) as Conversation[]);

    // Newest first, so the first sighting of an agent id is its latest job.
    const latest: Record<string, { status: string }> = {};
    for (const j of (jobRes.data ?? []) as { status: string; input_id: string | null }[]) {
      if (j.input_id && !latest[j.input_id]) latest[j.input_id] = { status: j.status };
    }
    setBuilds(latest);
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  const open = agents.find((a) => a.id === openId);
  const openConversations = conversations.filter((c) => c.sales_agent_id === openId);

  const setStatus = async (agent: SalesAgent, status: string) => {
    setBusy(true);
    const { error } = await supabase
      .from("client_sales_agents")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", agent.id);
    setBusy(false);
    if (error) {
      setNotice(`Could not change that: ${error.message}`);
      return;
    }
    setNotice(
      status === "live"
        ? `"${agent.name}" is live. It will answer visitors on the page it is attached to.`
        : `"${agent.name}" is ${status}.`,
    );
    void refresh();
  };

  const fields: FieldDef[] = [
    { name: "name", label: "Agent name", kind: "text", required: true },
    {
      name: "role",
      label: "What surface is this agent for",
      kind: "select",
      required: true,
      options: Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label })),
      hint: "Each agent covers one execution surface — build a separate agent for each one you need.",
    },
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
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {agents.map((a) => {
            const mine = conversations.filter((c) => c.sales_agent_id === a.id);
            const captured = mine.filter((c) => c.lead_id).length;
            const qualified = mine.filter((c) => c.qualified).length;
            const state = liveStateOf(a, builds[a.id]);
            const questions = a.qualification?.length ?? 0;

            return (
              <div
                key={a.id}
                className="flex flex-col rounded-lg border border-border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-card-foreground">{a.name}</h3>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                      STATE_TONE[state.kind],
                    )}
                  >
                    {state.label}
                  </span>
                </div>

                {a.role && (
                  <p className="mt-1 text-xs font-medium text-brand-strong">
                    {ROLE_LABEL[a.role] ?? a.role}
                  </p>
                )}
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{a.purpose}</p>

                {a.built_at ? (
                  <>
                    <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
                      <div>
                        <dt className="text-xs text-muted-foreground">Talked to</dt>
                        <dd className="text-lg font-semibold text-card-foreground">{mine.length}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Qualified</dt>
                        <dd className="text-lg font-semibold text-card-foreground">{qualified}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Leads</dt>
                        <dd className="text-lg font-semibold text-card-foreground">{captured}</dd>
                      </div>
                    </dl>

                    {/* An agent marked live that has said nothing is the thing
                        this page exists to surface, so last activity is stated
                        outright rather than left to be inferred from a zero. */}
                    <p className="mt-2 text-xs text-muted-foreground">
                      {mine.length === 0
                        ? a.status === "live"
                          ? "Live, but has not spoken to anyone yet"
                          : "No conversations yet"
                        : `Last conversation ${sinceLabel(mine[0]?.started_at ?? null)}`}
                    </p>

                    <p className="mt-1 text-xs text-muted-foreground">
                      {questions} question{questions === 1 ? "" : "s"} ·{" "}
                      {a.objections?.length ?? 0} objection
                      {(a.objections?.length ?? 0) === 1 ? "" : "s"}
                    </p>

                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                      <button
                        type="button"
                        onClick={() => setOpenId(a.id)}
                        className="rounded text-xs font-medium text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Open
                      </button>
                      {a.status !== "live" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void setStatus(a, "live")}
                          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Go live
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void setStatus(a, "retired")}
                          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Retire
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                    {state.kind === "failed"
                      ? "The last build failed. The agent activity bar above says why."
                      : "Waiting for the builder to write this."}
                  </p>
                )}
              </div>
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
          const { data, error } = await supabase
            .from("client_sales_agents")
            .insert({
              client_id: clientId,
              name: (v.name as string).trim(),
              role: (v.role as string) || null,
              purpose: (v.purpose as string).trim(),
              page_id: (v.page_id as string) || null,
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
              <div>
                <h2 className="text-base font-semibold text-card-foreground">{open.name}</h2>
                {open.role && (
                  <p className="text-xs text-muted-foreground">{ROLE_LABEL[open.role] ?? open.role}</p>
                )}
              </div>
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
                <h3 className="text-sm font-semibold text-foreground">Conversations</h3>
                {openConversations.length === 0 ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    Nothing yet. Conversations appear here once this agent is answering visitors on
                    a live page.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {openConversations.map((c) => (
                      <li key={c.id} className="rounded-lg border border-border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-card-foreground">
                            {c.contact_name ?? "Anonymous visitor"}
                          </p>
                          <span className="text-xs text-muted-foreground">
                            {sinceLabel(c.started_at)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {c.qualified ? "Qualified" : "Not qualified"}
                          {c.lead_id ? " · became a lead" : " · no lead"}
                          {c.handed_over ? " · handed to a person" : ""}
                          {c.contact_email || c.contact_phone
                            ? ` · ${c.contact_email ?? c.contact_phone}`
                            : ""}
                        </p>
                        {c.outcome && (
                          <p className="mt-1 text-xs text-muted-foreground">{c.outcome}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
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
