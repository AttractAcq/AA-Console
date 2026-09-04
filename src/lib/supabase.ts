import { createClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

if (!url || !key) {
  console.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY");
}

/**
 * The single Supabase client for all three consoles. Uses the publishable
 * key — safe to ship, since RLS decides who sees what. Never put a
 * service-role key in this app.
 */
export const supabase = createClient<Database>(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/**
 * Enqueue an agent job and get its id back. Every "Run"-shaped button and
 * every agent-backed form goes through here rather than calling a model.
 * The RPC refuses up front when the client is out of scope, the agent is
 * paused, or its upstream intelligence has not been generated yet.
 */
export async function enqueueAgentJob(args: {
  agentKey: string;
  clientId?: string;
  inputTable?: string;
  inputId?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("enqueue_agent_job", {
    p_agent_key: args.agentKey,
    p_client_id: args.clientId ?? undefined,
    p_input_table: args.inputTable ?? undefined,
    p_input_id: args.inputId ?? undefined,
  });
  if (error) throw error;
  return data as string;
}

/** Watch one job row until it leaves the queue. Returns an unsubscribe fn. */
export function watchAgentJob(
  jobId: string,
  onChange: (job: Database["public"]["Tables"]["agent_jobs"]["Row"]) => void,
) {
  const channel = supabase
    .channel(`agent_job:${jobId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "agent_jobs", filter: `id=eq.${jobId}` },
      (payload) => onChange(payload.new as Database["public"]["Tables"]["agent_jobs"]["Row"]),
    )
    .subscribe();
  return () => void supabase.removeChannel(channel);
}

/** Signed URL for a private bucket object. Buckets are never public. */
export async function signedUrl(bucket: string, path: string, expiresIn = 3600) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}
