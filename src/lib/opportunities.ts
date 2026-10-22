import { supabase } from "./supabase";
import { untypedSupabase } from "./untypedSupabase";
import type { Database } from "../types/database";

/**
 * The Micro-Market Opportunity Engine, from the browser's side.
 *
 * An opportunity is the commercial reason a campaign should exist: who, in
 * what situation, with what problem, wanting what, triggered by what. It sits
 * between intelligence and campaigns, and it links to both rather than
 * copying either.
 *
 * Every write goes through a function in migration 226, because the status
 * guard, the event log and the rule that an agent cannot raise its own
 * confidence are facts about the system rather than things each caller
 * remembers.
 */

export const OPPORTUNITY_STATUSES = [
  "discovered", "validated", "approved", "active", "learning", "scaling", "paused", "rejected",
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/**
 * How well evidenced it is, which is a different question from how
 * attractive it is. Ordered, lowest first, because "at least researched" is a
 * comparison people make.
 */
/** Taken from the enum now that the types know it, so the two cannot drift. */
export type OpportunityConfidence = Database["public"]["Enums"]["opportunity_confidence"];

export const CONFIDENCE_LEVELS = [
  { value: "hypothesis", label: "Hypothesis", hint: "A model proposed it. Nothing outside has checked it." },
  { value: "desk_research", label: "Desk research", hint: "Checked against sources outside the console." },
  { value: "conversation", label: "Conversation", hint: "Real buyers or the client's own sales calls say so." },
  { value: "first_party", label: "First-party data", hint: "The client's own customer records say so." },
  { value: "proven", label: "Proven", hint: "Campaigns against it have produced customers." },
] as const;

/** Not the templates' S0–S6: that axis is reach, this one is understanding. */
export const AWARENESS_STAGES = [
  { value: "unaware", label: "Unaware", mindset: "They do not frame this as a problem yet." },
  { value: "problem_aware", label: "Problem aware", mindset: "They feel the problem, not the solution." },
  { value: "solution_aware", label: "Solution aware", mindset: "They know this kind of solution exists." },
  { value: "product_aware", label: "Product aware", mindset: "They know this business could do it." },
  { value: "most_aware", label: "Most aware", mindset: "They are deciding whether to go ahead." },
] as const;

export const ATTRIBUTE_KINDS = [
  { value: "problem", label: "Problems" },
  { value: "outcome", label: "Desired outcomes" },
  { value: "motivation", label: "Motivations" },
  { value: "trigger", label: "Triggers" },
  { value: "objection", label: "Objections" },
] as const;

export interface Opportunity {
  id: string;
  client_id: string;
  name: string;
  micro_market: string;
  buying_situation: string;
  core_problem: string | null;
  desired_outcome: string | null;
  purchase_trigger: string | null;
  entry_awareness: string | null;
  positioning: string | null;
  conversion_action: string | null;
  status: OpportunityStatus;
  confidence: string;
  status_note: string | null;
  proposed_by: "human" | "agent";
  created_at: string;
}

export interface Readiness {
  opportunity_id: string;
  score: string | null;
  classification: string | null;
  open_proof_gaps: number;
  awareness_stages: number;
  blocker: string | null;
}

export interface ScoreFactor {
  factor: string;
  label: string;
  weight: number;
  note: string;
}

export async function fetchOpportunities(clientId: string): Promise<Opportunity[]> {
  const { data, error } = await supabase.from("market_opportunities")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as Opportunity[];
}

export async function fetchReadiness(clientId: string): Promise<Map<string, Readiness>> {
  const { data, error } = await supabase.from("opportunity_readiness")
    .select("opportunity_id, score, classification, open_proof_gaps, awareness_stages, blocker")
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as unknown as Readiness[]).map((row) => [row.opportunity_id, row]));
}

export async function fetchScoreFactors(): Promise<ScoreFactor[]> {
  const { data, error } = await supabase.from("opportunity_score_factors")
    .select("factor, label, weight, note")
    .order("weight", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ScoreFactor[];
}

export async function setFields(
  id: string,
  fields: Partial<Record<
    "core_problem" | "desired_outcome" | "purchase_trigger" | "entry_awareness" | "positioning" | "conversion_action",
    string
  >>,
): Promise<void> {
  // Each parameter defaults to null in SQL and coalesces to the stored value,
  // so a field left out keeps what it had. Passing an explicit null would be
  // the same thing to the function, and the generated types say optional
  // rather than nullable — so the key goes, not the value.
  const { error } = await supabase.rpc("set_opportunity_fields_v6", {
    p_opportunity_id: id,
    ...(fields.core_problem ? { p_core_problem: fields.core_problem } : {}),
    ...(fields.desired_outcome ? { p_desired_outcome: fields.desired_outcome } : {}),
    ...(fields.purchase_trigger ? { p_purchase_trigger: fields.purchase_trigger } : {}),
    ...(fields.entry_awareness ? { p_entry_awareness: fields.entry_awareness } : {}),
    ...(fields.positioning ? { p_positioning: fields.positioning } : {}),
    ...(fields.conversion_action ? { p_conversion_action: fields.conversion_action } : {}),
  });
  if (error) throw new Error(error.message);
}

export async function setAttributes(id: string, kind: string, values: string[]): Promise<void> {
  const { error } = await supabase.rpc("set_opportunity_attributes_v6", {
    p_opportunity_id: id, p_kind: kind, p_values: values,
  });
  if (error) throw new Error(error.message);
}

export async function setAwarenessStage(
  id: string, stage: string, mindset: string, message: string,
  assetDirection?: string, distributionNote?: string,
): Promise<void> {
  const { error } = await supabase.rpc("set_opportunity_awareness_v6", {
    p_opportunity_id: id, p_stage: stage, p_mindset: mindset, p_message: message,
    ...(assetDirection ? { p_asset_direction: assetDirection } : {}),
    ...(distributionNote ? { p_distribution_note: distributionNote } : {}),
  });
  if (error) throw new Error(error.message);
}

export async function linkOpportunity(id: string, role: string, targetId: string): Promise<void> {
  const { error } = await supabase.rpc("link_opportunity_v6", {
    p_opportunity_id: id, p_role: role, p_target_id: targetId,
  });
  if (error) throw new Error(error.message);
}

export async function scoreOpportunity(
  id: string, factors: Record<string, number>, note?: string,
): Promise<void> {
  const { error } = await supabase.rpc("score_market_opportunity_v6", {
    p_opportunity_id: id, p_factors: factors,
    ...(note ? { p_note: note } : {}),
  });
  if (error) throw new Error(error.message);
}

export async function setStatus(id: string, status: OpportunityStatus, note?: string): Promise<void> {
  const { error } = await supabase.rpc("set_opportunity_status_v6", {
    p_opportunity_id: id, p_status: status,
    ...(note ? { p_note: note } : {}),
  });
  if (error) throw new Error(error.message);
}

export async function setConfidence(
  id: string, confidence: OpportunityConfidence, note: string,
): Promise<void> {
  const { error } = await supabase.rpc("set_opportunity_confidence_v6", {
    p_opportunity_id: id, p_confidence: confidence, p_note: note,
  });
  if (error) throw new Error(error.message);
}

export async function requireProof(id: string, requirement: string): Promise<void> {
  const { error } = await supabase.rpc("require_opportunity_proof_v6", {
    p_opportunity_id: id, p_requirement: requirement,
  });
  if (error) throw new Error(error.message);
}

/** The bands the score falls into, and what each one means to do next. */
export const CLASSIFICATION_HINT: Record<string, string> = {
  scale: "Proven economics. Give it more.",
  test: "Promising, with assumptions still open.",
  research: "Not enough known to spend against it.",
  reject: "Weak economics or poor fit.",
};

/**
 * Create one campaign from this opportunity, on one route.
 *
 * The reasoning, the linked offer version and the link back are the
 * database's to assemble: migration 232 composes the brief from the
 * opportunity's own fields so that every caller gets the same brief from the
 * same opportunity, and re-reads readiness rather than trusting the approval
 * that happened weeks ago.
 *
 * It deliberately does not plan the campaign. Planning is a job with a cost,
 * and the caller queues it in the same breath it would for a hand-made
 * campaign, so a creation never silently spends.
 */
export async function createCampaignFromOpportunity(args: {
  opportunityId: string;
  acquisitionMode: "organic" | "paid";
  paidPlatform?: "meta" | "google" | null;
  name?: string | null;
}): Promise<{ id: string; name: string }> {
  const { data, error } = await untypedSupabase.rpc("create_campaign_from_opportunity_v6", {
    p_opportunity_id: args.opportunityId,
    p_acquisition_mode: args.acquisitionMode,
    p_paid_platform: args.acquisitionMode === "paid" ? (args.paidPlatform ?? null) : null,
    ...(args.name?.trim() ? { p_name: args.name.trim() } : {}),
  });
  if (error) throw new Error(error.message);
  // A set-returning function over a row type: one row, which the client
  // hands back as an array of one.
  const row = (Array.isArray(data) ? data[0] : data) as { id: string; name: string } | null;
  if (!row?.id) throw new Error("The campaign was not created.");
  return row;
}

/** Why a campaign exists: the opportunity it came from, as it stands now. */
export interface CampaignOrigin {
  campaign_id: string;
  opportunity_id: string;
  opportunity_name: string;
  micro_market: string;
  opportunity_status: string;
  confidence: string;
  score: number | null;
  classification: string | null;
  open_proof_gaps: number | null;
  opportunity_blocker: string | null;
}

export async function fetchCampaignOrigins(clientId: string): Promise<Map<string, CampaignOrigin>> {
  const { data, error } = await untypedSupabase
    .from("campaign_origins")
    .select(
      "campaign_id, opportunity_id, opportunity_name, micro_market, opportunity_status, confidence, score, classification, open_proof_gaps, opportunity_blocker",
    )
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as CampaignOrigin[]).map((row) => [row.campaign_id, row]));
}
