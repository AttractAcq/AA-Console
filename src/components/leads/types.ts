import type { LeadStage } from "./stages";

export type Lead = {
  id: string;
  name: string | null;
  contact: string | null;
  email: string | null;
  phone: string | null;
  stage: LeadStage;
  stage_at: string;
  next_action: string | null;
  next_action_due: string | null;
  opportunity_value: number | null;
  sale_value: number | null;
  cash_collected: number | null;
  source_channel: string | null;
  owner_member_id: string | null;
  appointment_at: string | null;
  appointment_outcome: string | null;
};

export type LeadEvent = {
  id: string;
  kind: string;
  body: string | null;
  from_stage: LeadStage | null;
  to_stage: LeadStage | null;
  occurred_at: string;
};
