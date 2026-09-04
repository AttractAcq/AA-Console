// The agents table is metadata: display name, config, upstream gates.
// dispatch.ts is the source of truth for what can actually run.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface AgentRow {
  agent_key: string;
  name: string;
  initials: string;
  domain: string | null;
  description: string | null;
  requires_upstream: string[];
  config: Record<string, unknown>;
  paused: boolean;
}

export async function getAgent(sb: SupabaseClient, agentKey: string): Promise<AgentRow> {
  const { data, error } = await sb
    .from("agents")
    .select("agent_key, name, initials, domain, description, requires_upstream, config, paused")
    .eq("agent_key", agentKey)
    .maybeSingle();
  if (error) throw new Error(`Failed to load agent ${agentKey}: ${error.message}`);
  if (!data) throw new Error(`Agent ${agentKey} is not registered.`);
  return data as AgentRow;
}
