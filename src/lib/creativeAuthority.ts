import { supabase } from "./supabase";
import type { Database } from "../types/database";

/**
 * Who decides a piece is good enough — G12.
 *
 * Two things were missing and one thing was misunderstood.
 *
 * The misunderstanding: `active_video_approval_manager` resolves to the SMM
 * assigned to the client, and forty-three functions gate on it. The SMM seat
 * has always existed and is the universal approver; its name just says video,
 * because video is what it was written for.
 *
 * What was missing: a creative director had nowhere to sit, and nothing
 * recorded which seat a decision was made from. So "who decides this is
 * on-brand" was a convention in somebody's team rather than a fact.
 */

export type CreativeAuthority =
  Database["public"]["Views"]["client_creative_authority"]["Row"];
export type CreativeDecision =
  Database["public"]["Views"]["creative_decisions"]["Row"];

export async function fetchCreativeAuthority(clientId: string): Promise<CreativeAuthority | null> {
  const { data, error } = await supabase
    .from("client_creative_authority")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as CreativeAuthority | null) ?? null;
}

/** Recent creative decisions, newest first. */
export async function fetchCreativeDecisions(
  clientId: string,
  limit = 20,
): Promise<CreativeDecision[]> {
  const { data, error } = await supabase
    .from("creative_decisions")
    .select("*")
    .eq("client_id", clientId)
    .order("decided_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as CreativeDecision[];
}

/**
 * Turns creative director sign-off on or off for a client.
 *
 * Off by default, and turning it on is a change to who may approve creative —
 * so it is a deliberate act by whoever runs the client, not a default.
 */
export async function setCreativeDirectorRequired(
  clientId: string,
  required: boolean,
): Promise<void> {
  const { error } = await supabase
    .from("client_engine_settings")
    .upsert({ client_id: clientId, creative_director_required: required } as never,
      { onConflict: "client_id" });
  if (error) throw new Error(error.message);
}
