#!/usr/bin/env node

/**
 * Non-mutating Supabase migration/catalog comparison.
 * Database URLs come only from environment variables; this tool never uses
 * supabase/.temp/project-ref, `--linked`, or a write-capable SQL transaction.
 */
import pg from "pg";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  boundedFindings,
  catalogObjects,
  compareCatalogs,
  compareHistory,
  historySummary,
  localSummary,
  readLocalMigrations,
  sha256,
} from "./schema-parity-core.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { Client } = pg;
const MAX_FINDINGS = 400;
const CATEGORY_PREFIX = {
  relations: "relation:", columns: "column:", constraints: "constraint:", indexes: "index:",
  policies: "policy:", functions: "function:", triggers: "trigger:",
  event_triggers: "event_trigger:", enums: "enum:", extensions: "extension:", cron: "cron:",
};

// `definition` is handled only in memory and immediately fingerprinted. It is
// deliberately omitted from every report, even for function bodies and cron.
export const CATALOG_QUERIES = [
  {
    name: "relations",
    sql: `select 'relation' as kind, format('%I.%I',n.nspname,c.relname) as identity,
      jsonb_build_object('kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
        'acl',c.relacl::text,'view',case when c.relkind in ('v','m') then pg_get_viewdef(c.oid,true) else null end) as definition
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','mcp_internal') and c.relkind in ('r','p','v','m','f')
      order by identity`,
  },
  {
    name: "columns",
    sql: `select 'column' as kind, format('%I.%I.%I',n.nspname,c.relname,a.attname) as identity,
      jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
        'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),
        'collation',a.attcollation::regcollation::text) as definition
      from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where n.nspname in ('public','mcp_internal') and c.relkind in ('r','p','v','m','f')
        and a.attnum>0 and not a.attisdropped order by identity`,
  },
  {
    name: "constraints",
    sql: `select 'constraint' as kind, format('%I.%I.%I',n.nspname,c.relname,x.conname) as identity,
      jsonb_build_object('type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid,true)) as definition
      from pg_constraint x join pg_class c on c.oid=x.conrelid
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','mcp_internal') order by identity`,
  },
  {
    name: "indexes",
    sql: `select 'index' as kind, format('%I.%I',n.nspname,i.relname) as identity,
      jsonb_build_object('definition',pg_get_indexdef(i.oid),'valid',x.indisvalid,'ready',x.indisready) as definition
      from pg_index x join pg_class i on i.oid=x.indexrelid
      join pg_class c on c.oid=x.indrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','mcp_internal') order by identity`,
  },
  {
    name: "policies",
    sql: `select 'policy' as kind, format('%I.%I.%I',schemaname,tablename,policyname) as identity,
      jsonb_build_object('permissive',permissive,'roles',roles,'command',cmd,'using',qual,'check',with_check) as definition
      from pg_policies where schemaname in ('public','mcp_internal','storage')
      order by identity`,
  },
  {
    name: "functions",
    sql: `select 'function' as kind,
      format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) as identity,
      jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl::text,
        'security_definer',p.prosecdef,'config',p.proconfig,'owner',pg_get_userbyid(p.proowner)) as definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','mcp_internal') and p.prokind in ('f','p','w')
      order by identity`,
  },
  {
    name: "triggers",
    sql: `select 'trigger' as kind, format('%I.%I.%I',n.nspname,c.relname,t.tgname) as identity,
      jsonb_build_object('definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) as definition
      from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','mcp_internal') and not t.tgisinternal order by identity`,
  },
  {
    name: "event_triggers",
    sql: `select 'event_trigger' as kind, e.evtname as identity,
      jsonb_build_object('event',e.evtevent,'enabled',e.evtenabled,'tags',e.evttags,
        'function',e.evtfoid::regprocedure::text) as definition
      from pg_event_trigger e order by identity`,
  },
  {
    name: "enums",
    sql: `select 'enum' as kind, format('%I.%I',n.nspname,t.typname) as identity,
      jsonb_build_object('labels',array_agg(e.enumlabel order by e.enumsortorder)) as definition
      from pg_type t join pg_namespace n on n.oid=t.typnamespace
      join pg_enum e on e.enumtypid=t.oid
      where n.nspname in ('public','mcp_internal') group by n.nspname,t.typname order by identity`,
  },
  {
    name: "extensions",
    sql: `select 'extension' as kind,e.extname as identity,
      jsonb_build_object('version',e.extversion,'schema',n.nspname) as definition
      from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by identity`,
  },
  {
    name: "cron",
    tableCheck: "cron.job",
    sql: `select 'cron' as kind,
      coalesce(jobname,'unnamed#' || jobid::text) as identity,
      jsonb_build_object('schedule',schedule,'command',command,'active',active) as definition
      from cron.job order by identity`,
  },
];

export const HISTORY_SQL = `select version,name,
  coalesce(cardinality(statements),0)::integer as statement_count,
  md5(array_to_string(statements,chr(10))) as stored_sql_md5,
  case when cardinality(statements)=1 then md5(rtrim(statements[1],' ' || chr(10) || chr(13) || chr(9))) else null end as single_statement_trimmed_md5
  from supabase_migrations.schema_migrations order by version`;

function safeError(error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : null;
  return { code, reason: code === "42501" ? "insufficient_privilege" : code === "42P01" ? "relation_missing" : "query_or_connection_failed" };
}

export function explicitDbUrl(value, label) {
  if (!value) throw new Error(`${label} is required; no linked project is used`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be a PostgreSQL URL`); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw new Error(`${label} must be a PostgreSQL URL with an explicit host and database`);
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase());
  if (!loopback && parsed.searchParams.get("sslmode") !== "verify-full") {
    throw new Error(`${label} requires sslmode=verify-full for a non-loopback database`);
  }
  return value;
}

function sameDbTarget(left, right) {
  const a = new URL(left);
  const b = new URL(right);
  return a.hostname.toLowerCase() === b.hostname.toLowerCase() && a.port === b.port && a.pathname === b.pathname;
}

/** Every catalog query uses a fresh transaction so one permission failure cannot hide other checks. */
export async function queryReadOnly(client, sql) {
  let begun = false;
  try {
    await client.query("BEGIN READ ONLY");
    begun = true;
    const check = await client.query("SHOW transaction_read_only");
    if (check.rows[0]?.transaction_read_only !== "on") throw new Error("Read-only transaction was not enforced");
    const result = await client.query(sql);
    return result.rows;
  } finally {
    if (begun) await client.query("ROLLBACK");
  }
}

export async function inspectEnvironment(name, dbUrl, ClientClass = Client) {
  const client = new ClientClass({ connectionString: dbUrl, application_name: "aa-schema-parity", query_timeout: 20000, statement_timeout: 15000 });
  const result = { name, history: null, objects: new Map(), categories: {}, errors: [] };
  try { await client.connect(); }
  catch (error) {
    result.errors.push({ category: "connection", ...safeError(error) });
    return result;
  }
  try {
    try {
      const rows = await queryReadOnly(client, HISTORY_SQL);
      result.history = rows.map((row) => ({
        version: String(row.version), name: row.name === null ? null : String(row.name),
        statementCount: Number(row.statement_count), storedSqlMd5: row.stored_sql_md5,
        singleStatementTrimmedMd5: row.single_statement_trimmed_md5,
      }));
    } catch (error) { result.errors.push({ category: "migration_history", ...safeError(error) }); }

    for (const entry of CATALOG_QUERIES) {
      try {
        if (entry.tableCheck) {
          const exists = await queryReadOnly(client, `select to_regclass('${entry.tableCheck}') is not null as present`);
          if (!exists[0]?.present) {
            result.categories[entry.name] = { status: "absent", count: 0 };
            continue;
          }
        }
        const rows = await queryReadOnly(client, entry.sql);
        const objects = catalogObjects(rows);
        for (const [key, object] of objects) {
          if (result.objects.has(key)) throw new Error("Duplicate catalog identity");
          result.objects.set(key, object);
        }
        result.categories[entry.name] = { status: "read", count: objects.size };
      } catch (error) {
        result.categories[entry.name] = { status: "unavailable", count: null };
        result.errors.push({ category: entry.name, ...safeError(error) });
      }
    }
  } finally { await client.end(); }
  return result;
}

export function sourceProvenance(root, local, types, runGit = execFileSync) {
  const git = (args) => {
    try { return runGit("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return null; }
  };
  const rawHead = git(["rev-parse", "HEAD"]);
  const wholeStatus = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const inputStatus = git(["status", "--porcelain=v1", "--untracked-files=all", "--", "supabase/migrations", "src/types/database.ts"]);
  return {
    headSha: rawHead && /^[0-9a-f]{40}$/i.test(rawHead) ? rawHead : null,
    workingTreeClean: wholeStatus === null ? null : wholeStatus === "",
    migrationInputsClean: inputStatus === null ? null : inputStatus === "",
    migrationSourceDigest: localSummary(local).digest,
    generatedTypesSha256: types.sha256,
  };
}

async function generatedTypesInfo() {
  const source = await readFile(resolve(ROOT, "src/types/database.ts"), "utf8");
  const info = { sourceFile: "src/types/database.ts", sha256: sha256(source), schemaDerivedComparison: "unverified" };
  const baselinePath = process.env.AA_SCHEMA_PARITY_GENERATED_TYPES_FILE;
  if (baselinePath) {
    const baseline = await readFile(resolve(baselinePath), "utf8");
    info.generatedSha256 = sha256(baseline);
    info.schemaDerivedComparison = info.sha256 === info.generatedSha256 ? "matching" : "different";
  }
  return info;
}

function findRequiredMissing(environment) {
  const required = ["extension:pgcrypto", "extension:pg_cron", "event_trigger:ensure_rls"];
  const findings = [];
  for (const key of required) {
    if (!environment.objects.has(key)) {
      const [kind, identity] = key.split(":");
      findings.push({ type: "required_object_missing", environment: environment.name, kind, identity, nextAction: "Verify the migration and a real catalog read before enabling dependent workers." });
    }
  }
  if (environment.categories.cron?.status === "absent") {
    findings.push({ type: "required_object_missing", environment: environment.name, kind: "relation", identity: "cron.job", nextAction: "Verify pg_cron installation and scheduling before relying on cron jobs." });
  }
  return findings;
}

export function buildReport(local, production, staging, types, baseline = null, provenance = sourceProvenance(ROOT, local, types)) {
  const findings = [];
  let historyComparison = null;
  if (production.history && staging.history) {
    historyComparison = compareHistory(local, production.history, staging.history, "production", "staging");
    findings.push(...historyComparison.findings);
  }
  const successfulCategories = CATALOG_QUERIES.map(({ name }) => name).filter((name) => production.categories[name]?.status === "read" && staging.categories[name]?.status === "read");
  for (const category of successfulCategories) {
    const prefix = CATEGORY_PREFIX[category];
    const selected = (objects) => new Map([...objects].filter(([key]) => key.startsWith(prefix)));
    findings.push(...compareCatalogs(selected(production.objects), selected(staging.objects), "production", "staging"));
  }
  for (const environment of [production, staging]) {
    if (environment.categories.extensions?.status === "read" && environment.categories.event_triggers?.status === "read") findings.push(...findRequiredMissing(environment));
  }
  if (types.schemaDerivedComparison === "different") findings.push({ type: "generated_types_mismatch", identity: types.sourceFile, nextAction: "Regenerate types from a clean replay at pinned service versions and review the diff." });
  if (baseline) {
    for (const environment of [production, staging]) {
      for (const category of successfulCategories.filter((name) => baseline.categories[name]?.status === "read")) {
        const prefix = CATEGORY_PREFIX[category];
        const selected = (objects) => new Map([...objects].filter(([key]) => key.startsWith(prefix)));
        findings.push(...compareCatalogs(selected(environment.objects), selected(baseline.objects), environment.name, "baseline"));
      }
    }
  }
  const incomplete = provenance.workingTreeClean !== true || provenance.migrationInputsClean !== true ||
    [production, staging, ...(baseline ? [baseline] : [])].some((environment) => environment.errors.length > 0 || !environment.history || CATALOG_QUERIES.some(({ name }) => !["read", "absent"].includes(environment.categories[name]?.status)));
  const bounded = boundedFindings(findings, MAX_FINDINGS);
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    gitSha: provenance.headSha,
    sourceProvenance: provenance,
    result: incomplete ? "incomplete" : bounded.total ? "drift" : "matching_snapshots",
    scope: baseline ? "production_staging_and_baseline" : "production_and_staging",
    localMigrations: localSummary(local),
    sourceToHistoryBody: historyComparison ? {
      provenEqualSingleStatement: historyComparison.singleStatementVerified,
      unverifiedRepresentationOrDifference: historyComparison.contentUnverified,
    } : null,
    environments: Object.fromEntries([production, staging, ...(baseline ? [baseline] : [])].map((environment) => [environment.name, {
      migrationHistory: environment.history ? historySummary(environment.history) : null,
      categories: environment.categories,
      errors: environment.errors,
    }])),
    generatedTypes: types,
    limitations: [
      "A matching migration version does not prove the SQL or object definition matches the source file.",
      "Supabase may store split SQL statements; a source-to-history body hash is only verified when a single stored statement exactly matches the source bytes after trimming trailing whitespace.",
      ...(baseline ? [] : ["Without a clean replay baseline, matching production/staging snapshots do not prove either matches the tracked migrations."]),
      ...(types.schemaDerivedComparison === "unverified" ? ["Generated database types were not independently regenerated for this report."] : []),
      ...(provenance.workingTreeClean === false ? ["The working tree contains uncommitted or untracked changes; HEAD alone does not identify the audited source."] : []),
      ...(provenance.workingTreeClean === null || provenance.migrationInputsClean === null ? ["Git working-tree status could not be verified; source provenance is incomplete."] : []),
    ],
    findings: bounded,
  };
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  if (argv.length === 0) return { output: null };
  if (argv.length === 2 && argv[0] === "--output") return { output: argv[1] };
  throw new Error("Usage: node scripts/schema-parity.mjs [--output report.json]");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("Set AA_SCHEMA_PARITY_PRODUCTION_URL and AA_SCHEMA_PARITY_STAGING_URL to explicit PostgreSQL URLs. Optional: AA_SCHEMA_PARITY_BASELINE_URL and AA_SCHEMA_PARITY_GENERATED_TYPES_FILE. Run: node scripts/schema-parity.mjs [--output report.json]\n");
    return;
  }
  const productionUrl = explicitDbUrl(process.env.AA_SCHEMA_PARITY_PRODUCTION_URL, "AA_SCHEMA_PARITY_PRODUCTION_URL");
  const stagingUrl = explicitDbUrl(process.env.AA_SCHEMA_PARITY_STAGING_URL, "AA_SCHEMA_PARITY_STAGING_URL");
  if (sameDbTarget(productionUrl, stagingUrl)) throw new Error("Production and staging URLs must target distinct databases");
  const baselineUrl = process.env.AA_SCHEMA_PARITY_BASELINE_URL ? explicitDbUrl(process.env.AA_SCHEMA_PARITY_BASELINE_URL, "AA_SCHEMA_PARITY_BASELINE_URL") : null;
  if (baselineUrl && [productionUrl, stagingUrl].some((url) => sameDbTarget(url, baselineUrl))) throw new Error("Baseline URL must target a distinct database");
  const local = await readLocalMigrations(ROOT);
  const types = await generatedTypesInfo();
  const production = await inspectEnvironment("production", productionUrl);
  const staging = await inspectEnvironment("staging", stagingUrl);
  const baseline = baselineUrl ? await inspectEnvironment("baseline", baselineUrl) : null;
  const report = buildReport(local, production, staging, types, baseline);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) await writeFile(resolve(args.output), json, { flag: "w", mode: 0o600 });
  else process.stdout.write(json);
  if (report.result !== "matching_snapshots") process.exitCode = report.result === "drift" ? 1 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // URL and connection errors may contain credentials. Only print a fixed,
    // non-secret message; detailed query categories are in the redacted JSON.
    process.stderr.write(`Schema parity audit could not start: ${error instanceof Error && /^(Usage:|AA_SCHEMA_PARITY_|Production and staging|Baseline URL|Unversioned migration|Duplicate migration)/.test(error.message) ? error.message : "input or filesystem failure"}\n`);
    process.exitCode = 2;
  });
}
