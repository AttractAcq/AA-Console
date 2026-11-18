#!/usr/bin/env node

/** Release guard for the historical fallback credential. Uses only Supabase's
 * read-only Management API endpoint and emits aggregate counts, never users. */
import { pathToFileURL } from "node:url";
import {
  explicitProjectRefs, readOnlyApiQuery, scopedReadToken,
} from "./schema-parity-read-only-api.mjs";

export const FALLBACK_COUNT_SQL =
  "select count(*)::integer as total_users,count(*) filter(where encrypted_password=extensions.crypt('change-me',encrypted_password))::integer as matching_users from auth.users";

export async function checkHostedAuthFallback(refs, token, fetchImpl = fetch) {
  const projects = explicitProjectRefs(refs.production, refs.staging);
  scopedReadToken(token);
  const counts = {};
  for (const [name, ref] of Object.entries(projects)) {
    const rows = await readOnlyApiQuery(ref, FALLBACK_COUNT_SQL, token, fetchImpl);
    if (rows.length !== 1 || !Number.isInteger(rows[0]?.total_users)
      || !Number.isInteger(rows[0]?.matching_users)
      || rows[0].matching_users < 0 || rows[0].matching_users > rows[0].total_users) {
      throw new Error("auth_fallback_aggregate_unverified");
    }
    counts[name] = { projectRef: ref, totalUsers: rows[0].total_users,
      matchingUsers: rows[0].matching_users };
  }
  return { status: Object.values(counts).every((entry) => entry.matchingUsers === 0)
    ? "pass" : "blocked", checkedAt: new Date().toISOString(), counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkHostedAuthFallback({
      production: process.env.AA_SCHEMA_PARITY_PRODUCTION_REF,
      staging: process.env.AA_SCHEMA_PARITY_STAGING_REF,
    }, process.env.AA_SCHEMA_PARITY_READ_TOKEN);
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.status !== "pass") process.exitCode = 1;
  } catch {
    process.stderr.write("auth_fallback_check_unverified\n");
    process.exitCode = 2;
  }
}
