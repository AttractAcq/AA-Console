#!/usr/bin/env node

/** Explicit, read-only Supabase Management API transport for schema parity.
 * A fine-grained PAT scoped to Database Read on the two named projects is
 * required. No linked Supabase project or write-capable SQL endpoint is used.
 */
import { readFile, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_QUERIES, HISTORY_SQL, buildReport, sourceProvenance } from "./schema-parity.mjs";
import { catalogObjects, readLocalMigrations, sha256 } from "./schema-parity-core.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BASE = "https://api.supabase.com/v1/projects";
const REF = /^[a-z0-9]{20}$/;

export function explicitProjectRefs(production, staging) {
  if (!REF.test(production ?? "") || !REF.test(staging ?? "")) throw new Error("Two explicit 20-character Supabase project refs are required");
  if (production === staging) throw new Error("Production and staging project refs must differ");
  return { production, staging };
}

export function scopedReadToken(value) {
  if (typeof value !== "string" || !value.startsWith("sbp_fc") || value.length < 16) {
    throw new Error("AA_SCHEMA_PARITY_READ_TOKEN must be a fine-grained Supabase PAT scoped to Database Read on both named projects");
  }
  return value;
}

async function request(ref, path, token, { method = "GET", body, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`${BASE}/${ref}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
  } catch {
    throw new Error("management_api_unreachable");
  }
  if (!response.ok) throw new Error(`management_api_http_${response.status}`);
  try { return await response.json(); }
  catch { throw new Error("management_api_invalid_json"); }
}

export async function readOnlyApiQuery(ref, sql, token, fetchImpl = fetch) {
  // All caller queries are fixed SELECTs. Keep this boundary explicit even
  // though Supabase executes the endpoint as supabase_read_only_user.
  if (!/^\s*select\b/i.test(sql) || sql.includes(";")) throw new Error("read_only_query_requires_one_select");
  const rows = await request(ref, "/database/query/read-only", token, { method: "POST", body: { query: sql }, fetchImpl });
  if (!Array.isArray(rows)) throw new Error("read_only_query_invalid_rows");
  return rows;
}

function publicError(error) {
  const message = error instanceof Error ? error.message : "unknown";
  return /^management_api_(unreachable|invalid_json|http_\d{3})$|^read_only_query_invalid_rows$/.test(message)
    ? message : "read_only_query_failed";
}

export async function inspectReadOnlyApi(name, ref, token, fetchImpl = fetch) {
  const result = { name, history: null, objects: new Map(), categories: {}, errors: [] };
  try {
    const rows = await readOnlyApiQuery(ref, HISTORY_SQL, token, fetchImpl);
    result.history = rows.map((row) => ({
      version: String(row.version), name: row.name === null ? null : String(row.name),
      statementCount: Number(row.statement_count), storedSqlMd5: row.stored_sql_md5,
      singleStatementTrimmedMd5: row.single_statement_trimmed_md5,
    }));
  } catch (error) {
    result.errors.push({ category: "migration_history", code: null, reason: publicError(error) });
  }

  for (const entry of CATALOG_QUERIES) {
    try {
      if (entry.tableCheck) {
        const check = await readOnlyApiQuery(ref, `select to_regclass('${entry.tableCheck}') is not null as present`, token, fetchImpl);
        if (!check[0]?.present) {
          result.categories[entry.name] = { status: "absent", count: 0 };
          continue;
        }
      }
      const rows = await readOnlyApiQuery(ref, entry.sql, token, fetchImpl);
      const objects = catalogObjects(rows);
      for (const [key, value] of objects) {
        if (result.objects.has(key)) throw new Error("duplicate_catalog_identity");
        result.objects.set(key, value);
      }
      result.categories[entry.name] = { status: "read", count: objects.size };
    } catch (error) {
      result.categories[entry.name] = { status: "unavailable", count: null };
      result.errors.push({ category: entry.name, code: null, reason: publicError(error) });
    }
  }
  return result;
}

// Compare the public/GraphQL schema block only. Supabase CLI and Management API
// generators can differ in helper types and PostgREST metadata. If the block
// boundaries change, return unverified rather than claiming a match.
export function generatedSchemaBody(source) {
  const start = source.indexOf("  graphql_public: {");
  const end = source.indexOf("\ntype DatabaseWithoutInternals");
  return start >= 0 && end > start ? source.slice(start, end) : null;
}

export async function readLiveTypes(ref, token, source, fetchImpl = fetch) {
  const result = await request(ref, "/types/typescript?included_schemas=public%2Cgraphql_public", token, { fetchImpl });
  if (typeof result.types !== "string") throw new Error("types_endpoint_invalid_response");
  const generated = result.types.replace(/\n+$/, "\n");
  const original = source.replace(/\n+$/, "\n");
  const body = generatedSchemaBody(generated);
  const originalBody = generatedSchemaBody(original);
  return {
    sha256: sha256(generated),
    exactFileMatchesCheckedIn: generated === original,
    schemaBodySha256: body === null ? null : sha256(body),
    schemaBodyMatchesCheckedIn: body === null || originalBody === null ? null : body === originalBody,
  };
}

export function generatedTypeStatus(production, staging) {
  const matches = [production?.schemaBodyMatchesCheckedIn, staging?.schemaBodyMatchesCheckedIn];
  return matches.includes(false) ? "different" : matches.every((match) => match === true) ? "matching" : "unverified";
}

export function requireVerifiedLiveTypes(report) {
  if (report.generatedTypes.schemaDerivedComparison === "unverified") {
    report.result = "incomplete";
    report.limitations.push("At least one live generated-types comparison was unavailable or its schema-body format could not be recognized.");
  }
  return report;
}

export async function buildReadOnlyApiReport({ refs, token, fetchImpl = fetch, root = ROOT }) {
  const local = await readLocalMigrations(root);
  const typeSource = await readFile(resolve(root, "src/types/database.ts"), "utf8");
  const [production, staging] = await Promise.all([
    inspectReadOnlyApi("production", refs.production, token, fetchImpl),
    inspectReadOnlyApi("staging", refs.staging, token, fetchImpl),
  ]);
  const remoteTypes = {};
  for (const [name, ref] of Object.entries(refs)) {
    try { remoteTypes[name] = await readLiveTypes(ref, token, typeSource, fetchImpl); }
    catch (error) { remoteTypes[name] = { error: publicError(error) }; }
  }
  const types = {
    sourceFile: "src/types/database.ts",
    sha256: sha256(typeSource),
    schemaDerivedComparison: generatedTypeStatus(remoteTypes.production, remoteTypes.staging),
    production: remoteTypes.production,
    staging: remoteTypes.staging,
    generatorFormatNote: "Only the public/GraphQL schema body is compared; generator helper and metadata formatting is excluded.",
  };
  const report = buildReport(local, production, staging, types, null, sourceProvenance(root, local, types));
  report.access = {
    method: "Supabase Management API /database/query/read-only (supabase_read_only_user)",
    projectRefs: refs,
    queryKind: "catalog and migration SELECT only",
    rawDefinitionsSaved: false,
  };
  return requireVerifiedLiveTypes(report);
}

function outputPath(argv) {
  if (argv.length === 2 && argv[0] === "--output" && argv[1]) return resolve(argv[1]);
  throw new Error("Usage: node scripts/schema-parity-read-only-api.mjs --output report.json");
}

async function main() {
  const output = outputPath(process.argv.slice(2));
  const refs = explicitProjectRefs(process.env.AA_SCHEMA_PARITY_PRODUCTION_REF, process.env.AA_SCHEMA_PARITY_STAGING_REF);
  const token = scopedReadToken(process.env.AA_SCHEMA_PARITY_READ_TOKEN);
  const report = await buildReadOnlyApiReport({ refs, token });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "w", mode: 0o600 });
  await chmod(output, 0o600);
  process.stdout.write(JSON.stringify({ result: report.result, createdAt: report.createdAt, gitSha: report.gitSha, findings: report.findings.total, output }) + "\n");
  if (report.result !== "matching_snapshots") process.exitCode = report.result === "drift" ? 1 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // A network or database error could contain a token or SQL. Report only
    // known non-secret validation errors; otherwise use a fixed message.
    const message = error instanceof Error && /^(Usage:|Two explicit|Production and staging project refs|AA_SCHEMA_PARITY_READ_TOKEN)/.test(error.message)
      ? error.message : "read-only audit input or API failure";
    process.stderr.write(`Schema parity audit could not start: ${message}\n`);
    process.exitCode = 2;
  });
}
