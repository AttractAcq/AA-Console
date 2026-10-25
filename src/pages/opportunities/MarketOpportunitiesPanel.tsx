import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";

import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { ActionMenu } from "../../components/ActionMenu";
import { ConfirmModal, FormModal } from "../../components/forms/FormModal";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { enqueueAgentJob } from "../../lib/supabase";
import { dayOrDash } from "../../lib/contentRecords";
import {
  ATTRIBUTE_KINDS, AWARENESS_STAGES, CLASSIFICATION_HINT, CONFIDENCE_LEVELS,
  createCampaignFromOpportunity,
  fetchOpportunities, fetchReadiness, fetchScoreFactors, requireProof, scoreOpportunity,
  fetchStageTemplates, setStageTemplate,
  setAttributes, setAwarenessStage, setConfidence, setFields, setStatus,
  type Opportunity, type OpportunityConfidence, type Readiness, type ScoreFactor,
  type StageTemplateCandidate,
} from "../../lib/opportunities";

/**
 * The Micro-Market Opportunity Engine.
 *
 * One business, one core service, many specific reasons to buy it. This is
 * where those reasons are found, compared, worked up and approved — the layer
 * between knowing a market and running campaigns at it.
 *
 * Four views, and they are four questions rather than four screens:
 *
 *   Discover   what buying situations might be worth pursuing
 *   Evaluate   which of them are worth spending against
 *   Strategize what we would have to say, prove and ask for
 *   Activate   what still stands in the way of approving one
 *
 * The thing the screens are built to keep visible is that an opportunity's
 * score and its confidence are different facts. Something can be the most
 * commercially attractive idea on the list and still be a guess a model made
 * twenty minutes ago, and a screen that showed one number would hide that.
 */

type View = "discover" | "evaluate" | "strategize" | "activate";

export function MarketOpportunitiesPanel({ view }: { view: View }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("opportunity");

  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [readiness, setReadiness] = useState<ReadonlyMap<string, Readiness>>(new Map());
  const [factors, setFactors] = useState<ScoreFactor[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  /** The opportunity a campaign is being created from, if any. */
  const [building, setBuilding] = useState<Opportunity | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    try {
      const [list, ready, scoring] = await Promise.all([
        fetchOpportunities(clientId), fetchReadiness(clientId), fetchScoreFactors(),
      ]);
      setOpportunities(list);
      setReadiness(ready);
      setFactors(scoring);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load opportunities.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Discovery takes minutes and files rows when it lands, so the page has to
  // reload itself rather than wait to be reloaded.
  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  const selected = opportunities.find((o) => o.id === selectedId) ?? null;
  const select = (id: string | null) =>
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (id) next.set("opportunity", id);
      else next.delete("opportunity");
      return next;
    });

  async function act(id: string, work: () => Promise<void>, said: string) {
    if (busy) return;
    setBusy(id);
    setNotice(null);
    setError(null);
    try {
      await work();
      setNotice(said);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  if (error && opportunities.length === 0) {
    return (
      <div role="alert">
        <p>{error}</p>
        <button type="button" onClick={() => void refresh()}>Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <AgentActivityBar inFlight={inFlight} failures={recentFailures} />
      {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {view === "discover" && (
        <DiscoverView
          clientId={clientId}
          opportunities={opportunities}
          readiness={readiness}
          loading={loading}
          busy={busy}
          discovering={discovering}
          onDiscover={() => setDiscovering(true)}
          onSelect={select}
          onAct={act}
        />
      )}
      {view !== "discover" && (
        <OpportunityPicker
          opportunities={opportunities}
          selectedId={selectedId}
          onSelect={select}
        />
      )}
      {view === "evaluate" && selected && (
        <EvaluateView
          opportunity={selected}
          readiness={readiness.get(selected.id)}
          factors={factors}
          busy={busy === selected.id}
          onAct={act}
        />
      )}
      {view === "strategize" && selected && (
        <StrategizeView opportunity={selected} busy={busy === selected.id} onAct={act} />
      )}
      {view === "activate" && (
        <ActivateView
          opportunities={opportunities}
          readiness={readiness}
          busy={busy}
          onSelect={select}
          onAct={act}
          onBuild={setBuilding}
        />
      )}
      {view !== "discover" && view !== "activate" && !selected && (
        <p className="text-sm text-muted-foreground">Choose an opportunity above.</p>
      )}

      <ConfirmModal
        open={discovering}
        onClose={() => setDiscovering(false)}
        title="Find micro-market opportunities"
        body="Reads this client's market, ICP, association and competitor records and proposes the specific buying situations worth pursuing. Everything it finds arrives as a hypothesis at discovered status — nothing is approved, and nothing can be spent against until a person evidences it and scores it. Takes a few minutes."
        confirmLabel="Find opportunities"
        onConfirm={async () => {
          if (!clientId) throw new Error("No client selected.");
          await enqueueAgentJob({ agentKey: "opportunity_discovery", clientId });
          setNotice("Looking. Anything found appears here as a hypothesis.");
        }}
        onDone={refresh}
      />

      {/* Creating the campaign is where the opportunity work either reaches
          the rest of the system or stops being used. The route is the one
          question a person has to answer, because 203 makes it immutable:
          the other route is a second campaign, not an edit. */}
      <FormModal
        open={building !== null}
        onClose={() => setBuilding(null)}
        title={building ? `Create a campaign for ${building.name}` : "Create a campaign"}
        submitLabel="Create and plan"
        intro="The campaign takes this opportunity's problem, outcome, trigger, positioning and objections as its brief, and binds the approved offer it is linked to. The route cannot be changed afterwards — the other route is a second campaign with its own lineage. Planning runs straight after, and costs what a plan costs."
        fields={[
          {
            name: "acquisition_mode", label: "Route", kind: "select", required: true,
            options: [
              { value: "organic", label: "Organic" },
              { value: "paid", label: "Paid" },
            ],
            hint: "A campaign is one or the other, for its whole life.",
          },
          {
            name: "paid_platform", label: "Paid platform", kind: "select",
            showIf: { field: "acquisition_mode", equals: ["paid"] },
            options: [
              { value: "meta", label: "Meta Ads" },
              { value: "google", label: "Google Ads (no builder yet)" },
            ],
          },
          {
            name: "name", label: "Campaign name", kind: "text",
            placeholder: building?.name ?? "",
            hint: "Left blank, it takes the opportunity's name.",
          },
        ]}
        onSubmit={async (values) => {
          if (!building) throw new Error("No opportunity selected.");
          const mode = values.acquisition_mode === "paid" ? "paid" : "organic";
          const platform = values.paid_platform === "google" ? "google" : "meta";
          if (mode === "paid" && !values.paid_platform) {
            throw new Error("Choose Meta Ads or Google Ads for a paid campaign.");
          }
          const campaign = await createCampaignFromOpportunity({
            opportunityId: building.id,
            acquisitionMode: mode,
            paidPlatform: mode === "paid" ? platform : null,
            name: typeof values.name === "string" ? values.name : null,
          });
          // Queued separately, exactly as the Campaign Factory form does it,
          // so that creating a campaign never silently spends on a plan.
          await enqueueAgentJob({
            agentKey: "campaign_plan",
            clientId: clientId!,
            inputTable: "client_campaigns",
            inputId: campaign.id,
          });
          setNotice(`${campaign.name} created. The planner is writing it now.`);
        }}
        onSaved={() => {
          setBuilding(null);
          void refresh();
        }}
      />
    </div>
  );
}

function OpportunityPicker({
  opportunities, selectedId, onSelect,
}: {
  opportunities: Opportunity[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="text-muted-foreground">Opportunity</span>
      <select
        value={selectedId ?? ""}
        onChange={(event) => onSelect(event.target.value || null)}
        className="mt-1 w-full max-w-xl rounded-lg border border-border bg-background p-2"
      >
        <option value="">Choose an opportunity</option>
        {opportunities.map((o) => (
          <option key={o.id} value={o.id}>{o.name} · {o.status}</option>
        ))}
      </select>
    </label>
  );
}

function DiscoverView({
  clientId, opportunities, readiness, loading, busy, discovering, onDiscover, onSelect, onAct,
}: {
  clientId: string | undefined;
  opportunities: Opportunity[];
  readiness: ReadonlyMap<string, Readiness>;
  loading: boolean;
  busy: string | null;
  discovering: boolean;
  onDiscover: () => void;
  onSelect: (id: string) => void;
  onAct: (id: string, work: () => Promise<void>, said: string) => Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          A micro-market is a buying situation, not a smaller demographic. Two people with the
          same income and postcode can buy the same service for completely different reasons, and
          each reason is a different route to a customer.
        </p>
        <Button icon={Search} disabled={!clientId || discovering} onClick={onDiscover}>
          Find opportunities
        </Button>
      </div>

      <DataTable
        columns={["Opportunity", "Micro-market", "Trigger", "Confidence", "Proposed", "Found", "Actions"]}
        emptyLabel={loading ? "Loading opportunities…" : "No opportunities yet — run a discovery pass"}
        rows={opportunities.map((o) => [
          <button
            key="n"
            type="button"
            onClick={() => onSelect(o.id)}
            className="text-left hover:underline"
          >
            {o.name}
            <span className="block text-xs text-muted-foreground">{o.status}</span>
          </button>,
          <span key="m">{o.micro_market}</span>,
          <span key="t">{o.purchase_trigger ?? "—"}</span>,
          <ConfidenceTag key="c" confidence={o.confidence} />,
          <span key="p" className="capitalize">{o.proposed_by}</span>,
          <span key="d">{dayOrDash(o.created_at)}</span>,
          <ActionMenu
            key="a"
            name={o.name}
            busy={busy === o.id}
            items={[
              ...(o.status === "discovered"
                ? [{
                    label: "Mark validated",
                    onSelect: () => void onAct(o.id, () => setStatus(o.id, "validated"), "Validated."),
                  }]
                : []),
              { label: "Work on it", onSelect: () => onSelect(o.id) },
              ...(readiness.get(o.id)?.blocker
                ? [{ label: "Why not ready", onSelect: () => onSelect(o.id) }]
                : []),
              {
                label: "Reject",
                destructive: true,
                onSelect: () => {
                  const why = window.prompt("Why is this not worth pursuing?");
                  if (why?.trim()) {
                    void onAct(o.id, () => setStatus(o.id, "rejected", why.trim()), "Rejected.");
                  }
                },
              },
            ]}
          />,
        ])}
      />
    </div>
  );
}

function ConfidenceTag({ confidence }: { confidence: string }) {
  const level = CONFIDENCE_LEVELS.find((l) => l.value === confidence);
  return (
    <span
      title={level?.hint}
      className={
        confidence === "hypothesis"
          ? "rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
          : "rounded-full bg-primary/10 px-2 py-0.5 text-xs text-brand-strong"
      }
    >
      {level?.label ?? confidence}
    </span>
  );
}

function EvaluateView({
  opportunity, readiness, factors, busy, onAct,
}: {
  opportunity: Opportunity;
  readiness: Readiness | undefined;
  factors: ScoreFactor[];
  busy: boolean;
  onAct: (id: string, work: () => Promise<void>, said: string) => Promise<void>;
}) {
  const [marks, setMarks] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [why, setWhy] = useState("");
  const [level, setLevel] = useState<OpportunityConfidence>(
    opportunity.confidence as OpportunityConfidence,
  );

  // Shown live, because the interesting moment is watching a weak factor pull
  // an attractive-looking opportunity down a band before you commit to it.
  const running = factors.reduce((total, f) => total + f.weight * (marks[f.factor] ?? 0), 0);
  const complete = factors.every((f) => marks[f.factor] !== undefined);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="space-y-3 rounded-xl border border-border bg-card p-5">
        <h3 className="font-semibold">Score it</h3>
        <p className="text-sm text-muted-foreground">
          Every factor, nought to a hundred. A partial score is refused: a total over five factors
          is not comparable with one over seven, and nothing on the screen would say which it was.
        </p>
        {factors.map((f) => (
          <label key={f.factor} className="block text-sm">
            <span className="flex items-baseline justify-between gap-2">
              <span>{f.label}</span>
              <span className="text-xs text-muted-foreground">{Math.round(f.weight * 100)}%</span>
            </span>
            <input
              type="number"
              min={0}
              max={100}
              aria-label={f.label}
              value={marks[f.factor] ?? ""}
              onChange={(e) =>
                setMarks((m) => ({ ...m, [f.factor]: Math.max(0, Math.min(100, Number(e.target.value))) }))
              }
              className="mt-1 w-full rounded-lg border border-border bg-background p-2"
            />
            <span className="text-xs text-muted-foreground">{f.note}</span>
          </label>
        ))}
        <label className="block text-sm">
          <span>Note</span>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || !complete}
            onClick={() =>
              void onAct(opportunity.id, () => scoreOpportunity(opportunity.id, marks, note), "Scored.")
            }
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Save score
          </button>
          <span className="text-sm text-muted-foreground">
            {complete ? `Would score ${running.toFixed(1)}` : "Score every factor"}
          </span>
        </div>
      </section>

      <section className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="font-semibold">Where it stands</h3>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Latest score</dt>
              <dd>{readiness?.score ?? "Not scored"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Band</dt>
              <dd>
                {readiness?.classification ?? "—"}
                {readiness?.classification && (
                  <span className="block text-xs text-muted-foreground">
                    {CLASSIFICATION_HINT[readiness.classification]}
                  </span>
                )}
              </dd>
            </div>
          </dl>
          {/* Deliberately beside the score rather than folded into it. An
              attractive opportunity nobody has evidenced is two facts. */}
          <p className="mt-4 text-xs uppercase tracking-wide text-muted-foreground">Evidence</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <ConfidenceTag confidence={opportunity.confidence} />
            <span className="text-xs text-muted-foreground">
              {CONFIDENCE_LEVELS.find((l) => l.value === opportunity.confidence)?.hint}
            </span>
          </div>
        </div>

        <div className="space-y-2 rounded-xl border border-border bg-card p-5">
          <h3 className="font-semibold">Move the evidence</h3>
          <select
            aria-label="Confidence"
            value={level}
            onChange={(e) => setLevel(e.target.value as OpportunityConfidence)}
            className="w-full rounded-lg border border-border bg-background p-2 text-sm"
          >
            {CONFIDENCE_LEVELS.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
          <input
            aria-label="What evidence moved this"
            placeholder="What evidence moved this?"
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            className="w-full rounded-lg border border-border bg-background p-2 text-sm"
          />
          <button
            type="button"
            disabled={busy || !why.trim()}
            onClick={() =>
              void onAct(opportunity.id, () => setConfidence(opportunity.id, level, why), "Evidence recorded.")
            }
            className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50"
          >
            Record evidence
          </button>
        </div>
      </section>
    </div>
  );
}

function StrategizeView({
  opportunity, busy, onAct,
}: {
  opportunity: Opportunity;
  busy: boolean;
  onAct: (id: string, work: () => Promise<void>, said: string) => Promise<void>;
}) {
  const [fields, setFieldState] = useState({
    core_problem: opportunity.core_problem ?? "",
    desired_outcome: opportunity.desired_outcome ?? "",
    purchase_trigger: opportunity.purchase_trigger ?? "",
    entry_awareness: opportunity.entry_awareness ?? "",
    positioning: opportunity.positioning ?? "",
    conversion_action: opportunity.conversion_action ?? "",
  });
  const [kind, setKind] = useState<string>(ATTRIBUTE_KINDS[0].value);
  const [lines, setLines] = useState("");
  const [stage, setStage] = useState<string>(AWARENESS_STAGES[0].value);
  const [mindset, setMindset] = useState("");
  const [message, setMessage] = useState("");
  const [requirement, setRequirement] = useState("");

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="space-y-3 rounded-xl border border-border bg-card p-5">
        <h3 className="font-semibold">The buying situation</h3>
        {([
          ["core_problem", "Problem"],
          ["desired_outcome", "Desired outcome"],
          ["purchase_trigger", "Trigger"],
          ["positioning", "Positioning"],
          ["conversion_action", "Conversion action"],
        ] as const).map(([key, label]) => (
          <label key={key} className="block text-sm">
            <span>{label}</span>
            <textarea
              rows={2}
              aria-label={label}
              value={fields[key]}
              onChange={(e) => setFieldState((f) => ({ ...f, [key]: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-border bg-background p-2"
            />
          </label>
        ))}
        <label className="block text-sm">
          <span>Where they usually join</span>
          <select
            aria-label="Entry awareness"
            value={fields.entry_awareness}
            onChange={(e) => setFieldState((f) => ({ ...f, entry_awareness: e.target.value }))}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2"
          >
            <option value="">Not decided</option>
            {AWARENESS_STAGES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onAct(opportunity.id, () => setFields(opportunity.id, fields), "Saved.")}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Save
        </button>
      </section>

      <div className="space-y-5">
        <section className="space-y-2 rounded-xl border border-border bg-card p-5">
          <h3 className="font-semibold">Lists</h3>
          <p className="text-xs text-muted-foreground">
            One per line, most pressing first — the order is the statement.
          </p>
          <select
            aria-label="List"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="w-full rounded-lg border border-border bg-background p-2 text-sm"
          >
            {ATTRIBUTE_KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
          <textarea
            rows={4}
            aria-label="List values"
            value={lines}
            onChange={(e) => setLines(e.target.value)}
            className="w-full rounded-lg border border-border bg-background p-2 text-sm"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void onAct(
                opportunity.id,
                () => setAttributes(opportunity.id, kind, lines.split("\n")),
                "List saved.",
              )
            }
            className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50"
          >
            Replace list
          </button>
        </section>

        <section className="space-y-2 rounded-xl border border-border bg-card p-5">
          <h3 className="font-semibold">Awareness journey</h3>
          <p className="text-xs text-muted-foreground">
            What this person has to understand at each step. Still a different axis from the
            templates&rsquo; S0–S6 &mdash; that one is what relationship they have with this client,
            this one is what they understand. The planner below bridges them, saying which states a
            stage&rsquo;s people are usually in and therefore which templates can reach them.
          </p>
          <select
            aria-label="Stage"
            value={stage}
            onChange={(e) => setStage(e.target.value)}
            className="w-full rounded-lg border border-border bg-background p-2 text-sm"
          >
            {AWARENESS_STAGES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <input
            aria-label="Mindset"
            placeholder="What they are thinking"
            value={mindset}
            onChange={(e) => setMindset(e.target.value)}
            className="w-full rounded-lg border border-border bg-background p-2 text-sm"
          />
          <input
            aria-label="Message"
            placeholder="What we say"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="w-full rounded-lg border border-border bg-background p-2 text-sm"
          />
          <button
            type="button"
            disabled={busy || !mindset.trim() || !message.trim()}
            onClick={() =>
              void onAct(
                opportunity.id,
                () => setAwarenessStage(opportunity.id, stage, mindset, message),
                "Stage saved.",
              )
            }
            className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50"
          >
            Save stage
          </button>
        </section>

        <StageTemplatePlanner opportunityId={opportunity.id} busy={busy} onAct={onAct} />

        <section className="space-y-2 rounded-xl border border-border bg-card p-5">
          <h3 className="font-semibold">What it would have to prove</h3>
          <p className="text-xs text-muted-foreground">
            A requirement with no proof against it is a gap, and a gap is a job rather than a
            silence. It blocks approval until it is captured or the claim changes.
          </p>
          <input
            aria-label="Proof requirement"
            placeholder="A completed garage conversion with costs"
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            className="w-full rounded-lg border border-border bg-background p-2 text-sm"
          />
          <button
            type="button"
            disabled={busy || !requirement.trim()}
            onClick={() =>
              void onAct(
                opportunity.id,
                async () => {
                  await requireProof(opportunity.id, requirement);
                  setRequirement("");
                },
                "Recorded as a proof gap.",
              )
            }
            className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50"
          >
            Add requirement
          </button>
        </section>
      </div>
    </div>
  );
}

function ActivateView({
  opportunities, readiness, busy, onSelect, onAct, onBuild,
}: {
  opportunities: Opportunity[];
  readiness: ReadonlyMap<string, Readiness>;
  busy: string | null;
  onSelect: (id: string) => void;
  onAct: (id: string, work: () => Promise<void>, said: string) => Promise<void>;
  onBuild: (opportunity: Opportunity) => void;
}) {
  const live = opportunities.filter((o) => o.status !== "rejected");
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">
        What still stands in the way of approving each one, in a sentence. Approval is the gate
        that lets money be spent against a hypothesis, so it reads this rather than trusting
        whoever clicks to have checked.
      </p>
      <DataTable
        columns={["Opportunity", "Status", "Score", "Proof gaps", "What is missing", "Actions"]}
        emptyLabel="Nothing to activate yet"
        rows={live.map((o) => {
          const r = readiness.get(o.id);
          return [
            <button key="n" type="button" onClick={() => onSelect(o.id)} className="text-left hover:underline">
              {o.name}
            </button>,
            <span key="s">{o.status}</span>,
            <span key="c">{r?.score ?? "—"}</span>,
            <span key="g" className={r && r.open_proof_gaps > 0 ? "text-destructive" : undefined}>
              {r?.open_proof_gaps ?? 0}
            </span>,
            <span key="b" className={r?.blocker ? "text-destructive" : "text-brand-strong"}>
              {r?.blocker ?? "Ready to approve"}
            </span>,
            <ActionMenu
              key="a"
              name={o.name}
              busy={busy === o.id}
              items={[
                ...(o.status === "validated" && !r?.blocker
                  ? [{
                      label: "Approve",
                      onSelect: () => void onAct(o.id, () => setStatus(o.id, "approved"), "Approved."),
                    }]
                  : []),
                // The hand-off. Offered from approved onwards and only while
                // nothing is blocking, because the database refuses it
                // otherwise and a button that always fails is worse than no
                // button.
                ...(["approved", "active", "learning", "scaling"].includes(o.status) && !r?.blocker
                  ? [{ label: "Create a campaign", onSelect: () => onBuild(o) }]
                  : []),
                ...(o.status === "approved"
                  ? [{
                      label: "Mark active",
                      onSelect: () => void onAct(o.id, () => setStatus(o.id, "active"), "Active."),
                    }]
                  : []),
                ...(o.status === "active"
                  ? [{
                      label: "Mark learning",
                      onSelect: () => void onAct(o.id, () => setStatus(o.id, "learning"), "Learning."),
                    }]
                  : []),
                ...(o.status === "learning"
                  ? [{
                      label: "Scale it",
                      onSelect: () => void onAct(o.id, () => setStatus(o.id, "scaling"), "Scaling."),
                    }]
                  : []),
                { label: "Work on it", onSelect: () => onSelect(o.id) },
                {
                  label: "Pause",
                  onSelect: () => {
                    const why = window.prompt("Why is this stopping?");
                    if (why?.trim()) void onAct(o.id, () => setStatus(o.id, "paused", why.trim()), "Paused.");
                  },
                },
              ]}
            />,
          ];
        })}
      />
    </div>
  );
}


/**
 * Which template moves each awareness stage — G06.
 *
 * The decision this exists for is the one that used to be tribal knowledge:
 * a stage says what its people understand, the templates say what audience
 * state they enter at, and nothing joined the two. Migration 244's map does,
 * so this shows the candidates with the trade-off beside each one.
 *
 * It recommends and does not choose. Every candidate carries its guardrail —
 * the way that template is most often got wrong — because the trade-off is
 * the half a strategist is actually weighing, and a list of options with no
 * cost attached would just be a dropdown.
 */
function StageTemplatePlanner({
  opportunityId, busy, onAct,
}: {
  opportunityId: string;
  busy: boolean;
  onAct: (id: string, work: () => Promise<void>, said: string) => Promise<void>;
}) {
  const [candidates, setCandidates] = useState<StageTemplateCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [why, setWhy] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      setCandidates(await fetchStageTemplates(opportunityId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load template candidates.");
    } finally {
      setLoading(false);
    }
  }, [opportunityId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** One group per stage, because the choice is per stage. */
  const stages = new Map<string, StageTemplateCandidate[]>();
  for (const row of candidates) {
    const list = stages.get(row.stage_id) ?? [];
    list.push(row);
    stages.set(row.stage_id, list);
  }

  if (loading) {
    return (
      <section className="rounded-xl border border-border bg-card p-5">
        <h3 className="font-semibold">Which template moves them</h3>
        <p className="text-xs text-muted-foreground">Loading…</p>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-5">
      <h3 className="font-semibold">Which template moves them</h3>
      <p className="text-xs text-muted-foreground">
        The sixteen that enter where each stage&rsquo;s people stand, with the way each one is most
        often got wrong. Choosing one records a reason; it does not build anything.
      </p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {stages.size === 0 ? (
        <p className="text-sm text-muted-foreground">
          Save an awareness stage above and its candidates appear here.
        </p>
      ) : (
        [...stages.entries()].map(([stageId, rows]) => {
          const first = rows[0]!;
          const chosen = rows.find((r) => r.chosen);
          const states = [...new Set(rows.map((r) => r.audience_state))].sort();
          return (
            <div key={stageId} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium">{first.awareness_level}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {states.join(" / ")}
                  {first.state_overridden && " (overridden)"}
                </span>
                {chosen && (
                  <span className="text-xs text-brand-strong">
                    chosen: {chosen.candidate_template} — {chosen.candidate_name}
                  </span>
                )}
              </div>
              {first.state_note && (
                <p className="mt-1 text-xs text-muted-foreground">{first.state_note}</p>
              )}

              <DataTable
                columns={["Template", "Does", "Needs", "Most often got wrong"]}
                emptyLabel="No template enters where these people stand"
                rows={rows.map((r) => [
                  <span key="t" className={r.chosen ? "font-mono text-brand-strong" : "font-mono"}>
                    {r.candidate_template}
                    <span className="block text-xs text-muted-foreground">{r.candidate_name}</span>
                  </span>,
                  <span key="d" className="text-xs">{r.fit}</span>,
                  <span key="n" className="text-xs">{r.prerequisite ?? "—"}</span>,
                  <span key="g" className="text-xs text-muted-foreground">{r.guardrail}</span>,
                ])}
              />

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  aria-label={`Template for ${first.awareness_level}`}
                  value={picked[stageId] ?? chosen?.candidate_template ?? ""}
                  onChange={(e) => setPicked((p) => ({ ...p, [stageId]: e.target.value }))}
                  className="rounded-lg border border-border bg-background p-2 text-sm"
                >
                  <option value="">Choose a template…</option>
                  {rows.map((r) => (
                    <option key={r.candidate_template} value={r.candidate_template}>
                      {r.candidate_template} — {r.candidate_name}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`Why for ${first.awareness_level}`}
                  placeholder="Why this one, for this stage"
                  value={why[stageId] ?? ""}
                  onChange={(e) => setWhy((w) => ({ ...w, [stageId]: e.target.value }))}
                  className="min-w-[14rem] flex-1 rounded-lg border border-border bg-background p-2 text-sm"
                />
                <Button
                  disabled={busy || !picked[stageId] || !(why[stageId] ?? "").trim()}
                  onClick={() =>
                    void onAct(
                      opportunityId,
                      async () => {
                        await setStageTemplate(stageId, picked[stageId]!, why[stageId]!.trim());
                        await refresh();
                      },
                      "Template recorded for this stage.",
                    )
                  }
                >
                  Record choice
                </Button>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
