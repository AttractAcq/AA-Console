import { createHash } from "node:crypto";
import type { RuntimeConfig } from "../config.js";
import manifest from "./schema-parity-manifest.json" with { type: "json" };

type HistoryRow = { version: string; name: string | null; statementCount: number; storedSqlMd5: string | null; singleStatementTrimmedMd5: string | null };
type CatalogObject = { kind: string; identity: string; fingerprint: string };
type Category = { status: "read" | "absent" | "unavailable"; count: number | null };
type Environment = { name: "production" | "staging"; history: HistoryRow[] | null; objects: Map<string, CatalogObject>; categories: Record<string, Category>; errors: { category: string; code: null; reason: string }[] };
type Finding = { type: string; [key: string]: unknown };
type Query = { name: string; sql: string; tableCheck?: string };
type TypeInfo = { sha256?: string; schemaBodySha256?: string | null; schemaBodyMatchesCheckedIn?: boolean | null; error?: string };

const BASE = "https://api.supabase.com/v1/projects";
const REF = /^[a-z0-9]{20}$/;
// These are public Supabase project identifiers, pinned to prevent a green
// report from accidentally comparing two other projects after an env typo.
const EXPECTED_REFS = { production: "bancbdztffokwiifzoiv", staging: "vmmertwoboqiazcsougw" } as const;
const CATEGORY_PREFIX: Record<string, string> = {
  relations: "relation:", columns: "column:", constraints: "constraint:", indexes: "index:",
  policies: "policy:", functions: "function:", triggers: "trigger:", event_triggers: "event_trigger:",
  enums: "enum:", extensions: "extension:", cron: "cron:",
};

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    return `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${stableJson(entry[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown";
  return /^api_(unreachable|invalid_json|http_\d{3}|invalid_rows)$/.test(message) ? message : "api_query_failed";
}

export function schemaParityConfig(config: RuntimeConfig): { token: string; refs: { production: string; staging: string } } | null {
  const token = config.schemaParityReadToken;
  const production = config.schemaParityProductionRef;
  const staging = config.schemaParityStagingRef;
  if (!token || !token.startsWith("sbp_fc") || !production || !staging || !REF.test(production) || !REF.test(staging) || production === staging) return null;
  if (production !== EXPECTED_REFS.production || staging !== EXPECTED_REFS.staging) return null;
  let runtimeRef: string | null = null;
  try { runtimeRef = /^([a-z0-9]{20})\.supabase\.co$/.exec(new URL(config.supabaseUrl).hostname)?.[1] ?? null; }
  catch { return null; }
  if (runtimeRef !== production) return null;
  return { token, refs: { production, staging } };
}

async function request(ref: string, path: string, token: string, fetchImpl: typeof fetch, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${BASE}/${ref}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
  } catch { throw new Error("api_unreachable"); }
  if (!response.ok) throw new Error(`api_http_${response.status}`);
  try { return await response.json(); }
  catch { throw new Error("api_invalid_json"); }
}

async function readOnly(ref: string, query: string, token: string, fetchImpl: typeof fetch): Promise<unknown[]> {
  if (!/^\s*select\b/i.test(query) || query.includes(";")) throw new Error("fixed_select_required");
  const rows = await request(ref, "/database/query/read-only", token, fetchImpl, { query });
  if (!Array.isArray(rows)) throw new Error("api_invalid_rows");
  return rows;
}

async function inspect(name: Environment["name"], ref: string, token: string, fetchImpl: typeof fetch): Promise<Environment> {
  const environment: Environment = { name, history: null, objects: new Map(), categories: {}, errors: [] };
  try {
    const rows = await readOnly(ref, manifest.historySql, token, fetchImpl);
    environment.history = rows.map((raw) => {
      if (!record(raw) || typeof raw.version !== "string") throw new Error("api_invalid_rows");
      return {
        version: raw.version, name: raw.name === null ? null : String(raw.name),
        statementCount: Number(raw.statement_count), storedSqlMd5: typeof raw.stored_sql_md5 === "string" ? raw.stored_sql_md5 : null,
        singleStatementTrimmedMd5: typeof raw.single_statement_trimmed_md5 === "string" ? raw.single_statement_trimmed_md5 : null,
      };
    });
  } catch (error) { environment.errors.push({ category: "migration_history", code: null, reason: errorCode(error) }); }

  for (const entry of manifest.catalogQueries as Query[]) {
    try {
      if (entry.tableCheck) {
        const check = await readOnly(ref, `select to_regclass('${entry.tableCheck}') is not null as present`, token, fetchImpl);
        if (!record(check[0]) || !check[0].present) {
          environment.categories[entry.name] = { status: "absent", count: 0 };
          continue;
        }
      }
      const rows = await readOnly(ref, entry.sql, token, fetchImpl);
      let count = 0;
      for (const raw of rows) {
        if (!record(raw) || typeof raw.kind !== "string" || typeof raw.identity !== "string") throw new Error("api_invalid_rows");
        const key = `${raw.kind}:${raw.identity}`;
        if (environment.objects.has(key)) throw new Error("duplicate_catalog_identity");
        environment.objects.set(key, { kind: raw.kind, identity: raw.identity, fingerprint: sha256(stableJson(raw.definition)) });
        count += 1;
      }
      environment.categories[entry.name] = { status: "read", count };
    } catch (error) {
      environment.categories[entry.name] = { status: "unavailable", count: null };
      environment.errors.push({ category: entry.name, code: null, reason: errorCode(error) });
    }
  }
  return environment;
}

function historySummary(rows: HistoryRow[] | null) {
  if (!rows) return null;
  const ordered = rows.toSorted((a, b) => a.version.localeCompare(b.version));
  return {
    count: ordered.length,
    head: ordered.at(-1)?.version ?? null,
    digest: sha256(stableJson(ordered.map(({ version, name, storedSqlMd5 }) => [version, name, storedSqlMd5]))),
    storedSqlPayloadAvailable: ordered.filter((row) => row.storedSqlMd5 !== null).length,
    storedSqlPayloadUnavailable: ordered.filter((row) => row.storedSqlMd5 === null).length,
  };
}

function compareHistory(production: HistoryRow[], staging: HistoryRow[]): { findings: Finding[]; sourceToHistoryBody: { provenEqualSingleStatement: Record<string, number>; unverifiedRepresentationOrDifference: Record<string, number>; storedSqlPayloadUnavailable: Record<string, number> } } {
  const findings: Finding[] = [];
  const source = new Map(manifest.localMigrations.map((row) => [row.version, row]));
  for (const [environment, history] of [["production", production], ["staging", staging]] as const) {
    const remote = new Map(history.map((row) => [row.version, row]));
    const remoteOnlyByName = new Map(history.filter((row) => !source.has(row.version)).map((row) => [row.name, row]));
    for (const local of manifest.localMigrations) {
      const recorded = remote.get(local.version);
      if (!recorded) {
        findings.push({ type: "locally_pending", environment, version: local.version, filename: local.filename, nextAction: "Review objects and release path; do not automatically apply." });
        const candidate = remoteOnlyByName.get(local.name);
        if (candidate) findings.push({ type: "possible_version_relabel", environment, localVersion: local.version, remoteVersion: candidate.version, name: local.name, nextAction: "Compare live object definitions; a name match is not proof of applied SQL equivalence." });
      } else if (recorded.name !== local.name) {
        findings.push({ type: "history_name_mismatch", environment, version: local.version, filename: local.filename, recordedName: recorded.name, nextAction: "Inspect recorded SQL and catalog lineage before history repair." });
      }
    }
    for (const recorded of history) if (!source.has(recorded.version)) findings.push({ type: "remote_only", environment, version: recorded.version, recordedName: recorded.name, nextAction: "Identify the exact object change before history repair." });
  }
  const prod = new Map(production.map((row) => [row.version, row]));
  const stage = new Map(staging.map((row) => [row.version, row]));
  for (const version of new Set([...prod.keys(), ...stage.keys()])) {
    const left = prod.get(version);
    const right = stage.get(version);
    if (left && right && left.storedSqlMd5 !== null && right.storedSqlMd5 !== null && left.storedSqlMd5 !== right.storedSqlMd5) {
      findings.push({ type: "recorded_sql_mismatch", version, environments: ["production", "staging"], recordedHashes: [left.storedSqlMd5, right.storedSqlMd5], nextAction: "Compare exact SQL and affected catalog objects." });
    }
  }
  const provenEqualSingleStatement: Record<string, number> = {};
  const unverifiedRepresentationOrDifference: Record<string, number> = {};
  const storedSqlPayloadUnavailable: Record<string, number> = {};
  for (const [environment, history] of [["production", production], ["staging", staging]] as const) {
    provenEqualSingleStatement[environment] = 0;
    unverifiedRepresentationOrDifference[environment] = 0;
    storedSqlPayloadUnavailable[environment] = history.filter((row) => row.storedSqlMd5 === null).length;
    if (storedSqlPayloadUnavailable[environment] > 0) findings.push({ type: "history_sql_payload_unavailable", environment, count: storedSqlPayloadUnavailable[environment], nextAction: "Stored SQL is NULL; compare live objects and source lineage. Do not treat an unavailable hash as a mismatch." });
    for (const recorded of history) {
      const local = source.get(recorded.version);
      if (!local) continue;
      if (recorded.statementCount === 1 && recorded.singleStatementTrimmedMd5 === local.trimmedMd5) provenEqualSingleStatement[environment] += 1;
      else unverifiedRepresentationOrDifference[environment] += 1;
    }
  }
  return { findings, sourceToHistoryBody: { provenEqualSingleStatement, unverifiedRepresentationOrDifference, storedSqlPayloadUnavailable } };
}

function compareCatalog(production: Environment, staging: Environment): Finding[] {
  const findings: Finding[] = [];
  for (const [category, prefix] of Object.entries(CATEGORY_PREFIX)) {
    if (production.categories[category]?.status !== "read" || staging.categories[category]?.status !== "read") continue;
    const keys = new Set([...production.objects.keys(), ...staging.objects.keys()].filter((key) => key.startsWith(prefix)));
    for (const key of keys) {
      const left = production.objects.get(key);
      const right = staging.objects.get(key);
      if (left?.fingerprint === right?.fingerprint) continue;
      const object = left ?? right;
      if (!object) continue;
      findings.push({
        type: !left ? "catalog_missing" : !right ? "catalog_extra" : "catalog_definition_mismatch",
        kind: object.kind, identity: object.identity, environments: ["production", "staging"],
        fingerprints: [left?.fingerprint ?? null, right?.fingerprint ?? null],
        nextAction: "Review exact object definition and migration lineage before a corrective migration.",
      });
    }
  }
  for (const environment of [production, staging]) {
    if (environment.categories.extensions?.status !== "read" || environment.categories.event_triggers?.status !== "read") continue;
    for (const key of ["extension:pgcrypto", "extension:pg_cron", "event_trigger:ensure_rls"]) {
      if (!environment.objects.has(key)) {
        const [kind, identity] = key.split(":");
        findings.push({ type: "required_object_missing", environment: environment.name, kind, identity, nextAction: "Verify the required object before enabling dependent workers." });
      }
    }
    if (environment.categories.cron?.status === "absent") findings.push({ type: "required_object_missing", environment: environment.name, kind: "relation", identity: "cron.job", nextAction: "Verify pg_cron installation and schedules." });
  }
  return findings;
}

function schemaBody(source: string): string | null {
  const start = source.indexOf("  graphql_public: {");
  const end = source.indexOf("\ntype DatabaseWithoutInternals");
  return start >= 0 && end > start ? source.slice(start, end) : null;
}

async function liveTypes(ref: string, token: string, fetchImpl: typeof fetch): Promise<TypeInfo> {
  try {
    const response = await request(ref, "/types/typescript?included_schemas=public%2Cgraphql_public", token, fetchImpl);
    if (!record(response) || typeof response.types !== "string") throw new Error("api_invalid_rows");
    const normalized = response.types.replace(/\n+$/, "\n");
    const body = schemaBody(normalized);
    return {
      sha256: sha256(normalized), schemaBodySha256: body === null ? null : sha256(body),
      schemaBodyMatchesCheckedIn: body === null ? null : sha256(body) === manifest.generatedSchemaBodySha256,
    };
  } catch (error) { return { error: errorCode(error) }; }
}

export async function collectSchemaParity(config: RuntimeConfig, fetchImpl: typeof fetch = fetch) {
  const enabled = schemaParityConfig(config);
  if (!enabled) throw new Error("schema_parity_read_access_unconfigured");
  const [production, staging] = await Promise.all([
    inspect("production", enabled.refs.production, enabled.token, fetchImpl),
    inspect("staging", enabled.refs.staging, enabled.token, fetchImpl),
  ]);
  const [productionTypes, stagingTypes] = await Promise.all([
    liveTypes(enabled.refs.production, enabled.token, fetchImpl),
    liveTypes(enabled.refs.staging, enabled.token, fetchImpl),
  ]);
  const history = production.history && staging.history ? compareHistory(production.history, staging.history) : null;
  const findings: Finding[] = [...(history?.findings ?? []), ...compareCatalog(production, staging)];
  const matchingTypes = productionTypes.schemaBodyMatchesCheckedIn;
  if (matchingTypes === false) findings.push({ type: "generated_types_mismatch", identity: "src/types/database.ts", nextAction: "Regenerate checked-in types from a clean replay and inspect the live schema." });
  const fullSha = process.env.RAILWAY_GIT_COMMIT_SHA ?? null;
  const gitSha = fullSha && /^[0-9a-f]{40}$/i.test(fullSha) ? fullSha : null;
  const queryIncomplete = !gitSha || !production.history || !staging.history || production.errors.length > 0 || staging.errors.length > 0 ||
    Object.values(production.categories).some((category) => category.status === "unavailable") ||
    Object.values(staging.categories).some((category) => category.status === "unavailable") ||
    matchingTypes === null || matchingTypes === undefined || stagingTypes.schemaBodyMatchesCheckedIn === null || stagingTypes.schemaBodyMatchesCheckedIn === undefined;
  const observedDrift = findings.some((finding) => finding.type !== "history_sql_payload_unavailable");
  const payloadUnavailable = Object.values(history?.sourceToHistoryBody.storedSqlPayloadUnavailable ?? {}).some((count) => count > 0);
  const ordered = findings.toSorted((a, b) => stableJson(a).localeCompare(stableJson(b)));
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    gitSha,
    sourceProvenance: {
      headSha: gitSha, workingTreeClean: gitSha ? true : null, migrationInputsClean: true,
      migrationSourceDigest: manifest.migrationSourceDigest, generatedTypesSha256: manifest.generatedTypesSha256,
    },
    result: queryIncomplete ? "incomplete" : observedDrift ? "drift" : payloadUnavailable ? "incomplete" : "matching_snapshots",
    scope: "production_and_staging",
    localMigrations: {
      count: manifest.localMigrations.length,
      head: manifest.localMigrations.at(-1)?.version ?? null,
      digest: manifest.migrationSourceDigest,
    },
    sourceToHistoryBody: history?.sourceToHistoryBody ?? null,
    environments: {
      production: { migrationHistory: historySummary(production.history), categories: production.categories, errors: production.errors },
      staging: { migrationHistory: historySummary(staging.history), categories: staging.categories, errors: staging.errors },
    },
    generatedTypes: {
      sourceFile: "src/types/database.ts", sha256: manifest.generatedTypesSha256,
      schemaDerivedComparison: matchingTypes === undefined || matchingTypes === null ? "unverified" : matchingTypes ? "matching" : "different",
      production: productionTypes, staging: stagingTypes,
      generatorFormatNote: "Only the public/GraphQL schema body is compared; generator helper and metadata formatting is excluded.",
    },
    access: {
      method: "Supabase Management API /database/query/read-only (supabase_read_only_user)",
      projectRefs: enabled.refs, queryKind: "catalog and migration SELECT only", rawDefinitionsSaved: false,
    },
    limitations: [
      "A matching migration version does not prove the SQL or object definition matches the source file.",
      "A NULL migration statements payload is unavailable evidence, not a differing SQL body.",
      "Without a clean replay baseline, matching production/staging snapshots do not prove either matches the tracked migrations.",
      ...(queryIncomplete ? ["At least one live read, generated-type comparison or runtime commit identity was unavailable."] : []),
    ],
    findings: { total: ordered.length, shown: ordered.slice(0, 400), omitted: Math.max(0, ordered.length - 400) },
  };
}
