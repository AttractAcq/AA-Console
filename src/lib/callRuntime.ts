import { supabase } from "./supabase";

/**
 * Call an admin endpoint on the agent runtime as the signed-in user.
 *
 * The runtime re-checks that the caller is an admin; this only carries the
 * session. The thrown message is the runtime's own sentence, which is written
 * to be read by whoever pressed the button — "that page has no built HTML yet",
 * "needs an Organization installation" — so it is shown rather than replaced
 * with something generic.
 */
export async function callRuntime<T>(path: string, body: unknown): Promise<T> {
  const base = (import.meta.env.VITE_AGENT_RUNTIME_URL as string | undefined)?.replace(/\/+$/, "");
  if (!base) throw new Error("The agent runtime URL is not configured.");

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the agent runtime.");
  }

  const parsed = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!parsed) throw new Error("The agent runtime returned something unreadable.");
  if (!res.ok || parsed.ok !== true) throw new Error(parsed.error ?? "That did not work.");
  return parsed as T;
}
