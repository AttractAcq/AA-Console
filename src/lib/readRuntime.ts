import { supabase } from "./supabase";

/** Read an admin-only runtime resource using the current Supabase session. */
export async function readRuntime<T>(path: string): Promise<T> {
  const base = (import.meta.env.VITE_AGENT_RUNTIME_URL as string | undefined)?.replace(/\/+$/, "");
  if (!base) throw new Error("The agent runtime URL is not configured.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in before reading system readiness.");
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    throw new Error("Could not reach the agent runtime.");
  }
  const body = await response.json().catch(() => null) as ({ ok?: boolean; error?: string } & T) | null;
  if (!body) throw new Error("The agent runtime returned something unreadable.");
  if (!response.ok || body.ok !== true) throw new Error(body.error ?? "System readiness is unavailable.");
  return body;
}
