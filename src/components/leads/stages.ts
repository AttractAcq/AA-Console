import type { Database } from "../../types/database";

export type LeadStage = Database["public"]["Enums"]["lead_stage"];

export const PIPELINE_STAGES: { id: LeadStage; label: string }[] = [
  { id: "profile_visit", label: "Profile Visits" },
  { id: "follower", label: "Followers" },
  { id: "qualified", label: "Qualified" },
  { id: "conversation", label: "Conversations" },
  { id: "qualified_conversation", label: "Qualified Conversations" },
  { id: "appointment", label: "Appointments" },
  { id: "qualified_appointment", label: "Qualified Appointments" },
  { id: "shown", label: "Show Ups" },
  { id: "cash", label: "Cash Collected" },
];

export const STAGE_OPTIONS = [...PIPELINE_STAGES, { id: "lost" as LeadStage, label: "Lost" }];

export function stageLabel(stage: LeadStage): string {
  return STAGE_OPTIONS.find((item) => item.id === stage)?.label ?? stage;
}
