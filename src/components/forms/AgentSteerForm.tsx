import { FormModal } from "./FormModal";
import type { FieldDef, FormValues } from "./fields";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type RecordDomain = Database["public"]["Enums"]["record_domain"];

type AgentFormConfig = {
  title: string;
  agentKey: string;
  intro: string;
  fields: FieldDef[];
  /** Turn raw form values into the jsonb payload. */
  toPayload?: (values: FormValues) => Record<string, unknown>;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * One line per competitor: "Name — https://url" or "Name, https://url".
 * A repeater control would be nicer; this keeps the whole agent surface
 * to one component and parses to the same shape.
 */
function parseCompetitors(raw: string) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+[—–-]\s+|,\s*/);
      return { name: parts[0]?.trim() ?? line, url: parts[1]?.trim() ?? null };
    });
}

export const AGENT_FORMS: Record<RecordDomain, AgentFormConfig> = {
  reporting: {
    title: "Reporting Commentary",
    agentKey: "reporting",
    intro:
      "Reads the metrics already ingested for this client and writes the client-facing narrative. It never invents a figure — if nothing has been ingested yet, it will say so rather than guess.",
    fields: [
      {
        name: "period_days",
        label: "Period",
        kind: "select",
        options: [
          { value: "7", label: "Last 7 days" },
          { value: "30", label: "Last 30 days" },
          { value: "90", label: "Last 90 days" },
        ],
        hint: "A short window shows what just changed; a long one shows whether it holds.",
      },
    ],
    toPayload: (values) => ({ period_days: Number(values.period_days ?? 30) }),
  },

  icp: {
    title: "ICP Inputs",
    agentKey: "icp",
    intro:
      "The ICP agent already reads your Business Context. Both fields below are optional uplift.",
    fields: [
      {
        name: "focus_segment",
        label: "Focus segment",
        kind: "text",
        placeholder: "Narrow to one segment, if the business has several",
      },
      {
        name: "voice_of_customer",
        label: "Customer language",
        kind: "textarea",
        rows: 5,
        placeholder: "Paste real DMs, reviews, objections or call notes",
        hint: "The single biggest quality lever — real quotes are what make the question universe specific.",
      },
    ],
  },

  competitor: {
    title: "Competitor Inputs",
    agentKey: "competitor",
    intro: "Name the competitors. Everything else on this tab is what the agent produces.",
    fields: [
      {
        name: "competitors",
        label: "Competitors",
        kind: "textarea",
        rows: 6,
        required: true,
        placeholder: "Acme Pools — https://acmepools.co.za\nBlue Water, https://bluewater.co.za",
        hint: "One per line. Name first, then URL after a dash or comma.",
      },
    ],
    toPayload: (v) => ({ competitors: parseCompetitors(str(v.competitors)) }),
  },

  association: {
    title: "Branding Inputs",
    agentKey: "association",
    intro: "Guardrails for the association map. Both optional.",
    fields: [
      {
        name: "avoid",
        label: "Associations to avoid",
        kind: "textarea",
        rows: 3,
        placeholder: "Never position us next to…",
        hint: "Propagates to every downstream content agent.",
      },
      { name: "desired", label: "Associations to build", kind: "textarea", rows: 3 },
    ],
  },

  market: {
    title: "Market Inputs",
    agentKey: "market",
    intro: "Optional steer for the market research run.",
    fields: [
      { name: "geography", label: "Geography", kind: "text", placeholder: "Where this market is" },
    ],
  },

  campaign_intel: {
    title: "Campaign Inputs",
    agentKey: "campaign_intel",
    intro: "Timing and seasonality for one year.",
    fields: [
      {
        name: "year",
        label: "Year",
        kind: "number",
        required: true,
        placeholder: String(new Date().getFullYear()),
      },
      {
        name: "key_dates",
        label: "Known dates",
        kind: "textarea",
        rows: 4,
        placeholder: "Launches, busy season, closures, annual events",
        hint: "A model can guess your industry's seasonality. It cannot know you close for two weeks in July.",
      },
    ],
  },

  proof: {
    title: "Proof Inputs",
    agentKey: "proof",
    intro:
      "Proof Intelligence reads your business context and ICP. Anything you add here is proof the agent would otherwise never know about.",
    fields: [
      {
        name: "known_proof",
        label: "Proof you already have",
        kind: "textarea",
        rows: 5,
        placeholder: "Results, credentials, case outcomes, awards, named clients, anything demonstrable",
        hint: "Only things that genuinely exist. This agent will not invent proof, and it should not have to guess either.",
      },
    ],
  },

  brand_strategy: {
    title: "Branding Input",
    agentKey: "brand_strategy",
    intro:
      "Brand Strategy synthesises your ICP, Competitor and Association records — it reads them directly, so there is nothing to re-enter.",
    fields: [
      {
        name: "constraint",
        label: "Strategic constraint",
        kind: "textarea",
        rows: 3,
        placeholder: "Anything the strategy must work around",
      },
    ],
  },

  offer_strategy: {
    title: "Offer Input",
    agentKey: "offer_strategy",
    intro: "Your main offer comes from Business Context. These two shape how it gets packaged.",
    fields: [
      { name: "price_point", label: "Price point", kind: "text" },
      {
        name: "constraints",
        label: "Cannot promise",
        kind: "textarea",
        rows: 3,
        placeholder: "Compliance limits, claims you cannot make, guarantees you cannot honour",
        hint: "Stops an unhonourable guarantee being generated and then published.",
      },
    ],
  },

  money_model: {
    title: "Money Model Input",
    agentKey: "money_model",
    intro: "Gated on Offer Strategy. The four offer types are the agent's output.",
    fields: [
      {
        name: "model_preference",
        label: "Model preference",
        kind: "select",
        options: [
          { value: "subscription", label: "Subscription" },
          { value: "one_off", label: "One-off" },
          { value: "hybrid", label: "Hybrid" },
          { value: "agent", label: "Let the agent decide" },
        ],
      },
    ],
  },
};

/**
 * Writes one client_agent_inputs row, then enqueues the job. The browser
 * never runs the agent — it hands the work to the queue and returns.
 */
export async function submitAgentRun(
  domain: RecordDomain,
  clientId: string,
  values: FormValues,
): Promise<string> {
  const config = AGENT_FORMS[domain];
  const payload = config.toPayload
    ? config.toPayload(values)
    : Object.fromEntries(
        Object.entries(values)
          .map(([k, v]) => [k, typeof v === "string" ? v.trim() : v])
          .filter(([, v]) => v !== "" && v !== null && v !== false),
      );

  const { data: input, error: inputError } = await supabase
    .from("client_agent_inputs")
    .insert({ client_id: clientId, domain, payload })
    .select("id")
    .single();
  if (inputError) throw inputError;

  const { data: jobId, error: jobError } = await supabase.rpc("enqueue_agent_job", {
    p_agent_key: config.agentKey,
    p_client_id: clientId,
    p_input_table: "client_agent_inputs",
    p_input_id: input.id,
  });
  if (jobError) throw new Error(jobError.message);
  return jobId as string;
}

export function AgentSteerForm({
  domain,
  clientId,
  open,
  onClose,
  onQueued,
}: {
  domain: RecordDomain;
  clientId: string | undefined;
  open: boolean;
  onClose: () => void;
  onQueued?: () => void;
}) {
  const config = AGENT_FORMS[domain];
  return (
    <FormModal
      open={open}
      onClose={onClose}
      title={config.title}
      draftKey={`agent:${domain}:${clientId}`}
      intro={config.intro}
      fields={config.fields}
      submitLabel="Run agent"
      onSubmit={async (values) => {
        if (!clientId) throw new Error("No client selected.");
        await submitAgentRun(domain, clientId, values);
      }}
      onSaved={onQueued}
    />
  );
}
