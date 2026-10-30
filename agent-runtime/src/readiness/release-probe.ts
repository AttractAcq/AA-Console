import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { deployedCommitSha } from "./version.js";

type ReleaseProbe = {
  schemaVersion: 1;
  observedAt: string;
  observationsComplete: boolean;
  runtimeSha: string | null;
  gatewaySha: string | null;
  migrationHead: string | null;
  reason: "runtime_sha_unknown" | "schema_unavailable" | "gateway_unconfigured" | "gateway_unavailable" | null;
};

function fullSha(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

async function within<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("release_probe_timeout")), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Minimal public deployment identity. The service credential and database
 * catalog stay server-side; no client inventory or integration state escapes. */
export async function collectReleaseProbe(
  sb: SupabaseClient,
  config: RuntimeConfig,
  fetcher: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReleaseProbe> {
  const observedAt = new Date().toISOString();
  const runtimeSha = deployedCommitSha(env);
  const empty = (reason: Exclude<ReleaseProbe["reason"], null>, migrationHead: string | null = null): ReleaseProbe => ({
    schemaVersion: 1, observedAt, observationsComplete: false, runtimeSha, gatewaySha: null, migrationHead, reason,
  });
  if (!runtimeSha) return empty("runtime_sha_unknown");

  let migrationHead: string | null;
  try {
    const result = await within(Promise.resolve(sb.rpc("system_readiness_catalog")), 3000);
    const data = result.data;
    if (result.error || !data || typeof data !== "object" || Array.isArray(data) ||
        typeof data.migrationHead !== "string" || !/^\d{14}$/.test(data.migrationHead))
      return empty("schema_unavailable");
    migrationHead = data.migrationHead;
  } catch { return empty("schema_unavailable"); }

  if (!config.gatewayUrl || !config.mcpServiceSecret)
    return empty("gateway_unconfigured", migrationHead);
  try {
    const response = await within(fetcher(`${config.gatewayUrl}/internal/readiness`, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.mcpServiceSecret}` },
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    }), 3000);
    if (!response.ok) return empty("gateway_unavailable", migrationHead);
    const body: unknown = await within(response.json(), 3000);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return empty("gateway_unavailable", migrationHead);
    const record = body as Record<string, unknown>;
    const gatewaySha = fullSha(record.sha);
    const age = Date.now() - Date.parse(String(record.observedAt ?? ""));
    if (record.ok !== true || !gatewaySha || !Number.isFinite(age) || age < -5000 || age > 30_000)
      return empty("gateway_unavailable", migrationHead);
    return { schemaVersion: 1, observedAt, observationsComplete: true, runtimeSha, gatewaySha, migrationHead, reason: null };
  } catch { return empty("gateway_unavailable", migrationHead); }
}

let cache: { value: ReleaseProbe; at: number } | null = null;
let pending: Promise<ReleaseProbe> | null = null;

export async function currentReleaseProbe(sb: SupabaseClient, config: RuntimeConfig): Promise<ReleaseProbe> {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  if (pending) return pending;
  pending = collectReleaseProbe(sb, config);
  try {
    const value = await pending;
    cache = { value, at: Date.now() };
    return value;
  } finally { pending = null; }
}
