// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  boundedFindings, catalogObjects, compareCatalogs, compareHistory, sha256,
} from "./schema-parity-core.mjs";
import {
  buildReport, CATALOG_QUERIES, explicitDbUrl, HISTORY_SQL, inspectEnvironment, queryReadOnly, sourceProvenance,
} from "./schema-parity.mjs";

const local = [
  { version: "20261025090000", name: "first", filename: "20261025090000_first.sql", sha256: "a", trimmedMd5: "a" },
  { version: "20261025100000", name: "second", filename: "20261025100000_second.sql", sha256: "b", trimmedMd5: "b" },
];
const row = (version, name, hash = "same") => ({ version, name, statementCount: 2, storedSqlMd5: hash, singleStatementTrimmedMd5: null });
const cleanProvenance = { headSha: "7f08c4b30f77ed662c669b372424898d35c4cc3d", workingTreeClean: true, migrationInputsClean: true, migrationSourceDigest: "x", generatedTypesSha256: "y" };

describe("migration parity classification", () => {
  it("detects an out-of-order application under another version without claiming equivalence", () => {
    const result = compareHistory(local, [row("20261025090000", "first"), row("20261025110000", "second")],
      [row("20261025090000", "first"), row("20261025100000", "second")], "production", "staging");
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "locally_pending", environment: "production", version: "20261025100000" }),
      expect.objectContaining({ type: "remote_only", environment: "production", version: "20261025110000" }),
      expect.objectContaining({ type: "possible_version_relabel", environment: "production", localVersion: "20261025100000", remoteVersion: "20261025110000" }),
    ]));
    expect(result.findings.find((finding) => finding.type === "possible_version_relabel")?.nextAction).toMatch(/candidate, not proof/);
  });

  it("flags renamed versions and differing stored SQL while keeping file-body equality unknown", () => {
    const result = compareHistory(local, [row("20261025090000", "renamed", "x"), row("20261025100000", "second")],
      [row("20261025090000", "first", "y"), row("20261025100000", "second")], "production", "staging");
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "history_name_mismatch", version: "20261025090000" }),
      expect.objectContaining({ type: "recorded_sql_mismatch", version: "20261025090000" }),
    ]));
    expect(result.contentUnverified.production).toBe(2);
    expect(result.singleStatementVerified.production).toBe(0);
  });

  it("treats NULL history statements as unavailable evidence instead of 271 invented SQL mismatches", () => {
    const production = [row("20261025090000", "first", "hash-a"), row("20261025100000", "second", "hash-b")];
    const staging = [row("20261025090000", "first", null), row("20261025100000", "second", null)];
    const result = compareHistory(local, production, staging, "production", "staging");
    expect(result.findings.filter((finding) => finding.type === "recorded_sql_mismatch")).toHaveLength(0);
    expect(result.findings).toContainEqual(expect.objectContaining({ type: "history_sql_payload_unavailable", environment: "staging", count: 2 }));
    expect(result.storedSqlPayloadUnavailable).toEqual({ production: 0, staging: 2 });
  });
});

describe("catalog and report", () => {
  it("detects changed function, policy, and cron definitions without returning SQL bodies", () => {
    const a = catalogObjects([
      { kind: "function", identity: "public.f()", definition: { body: "secret v1" } },
      { kind: "policy", identity: "public.t.read", definition: { using: "client_id = 1" } },
      { kind: "cron", identity: "nightly", definition: { command: "select run(1)" } },
    ]);
    const b = catalogObjects([
      { kind: "function", identity: "public.f()", definition: { body: "secret v2" } },
      { kind: "policy", identity: "public.t.read", definition: { using: "client_id = 2" } },
      { kind: "cron", identity: "nightly", definition: { command: "select run(2)" } },
    ]);
    const findings = compareCatalogs(a, b, "production", "staging");
    expect(findings).toHaveLength(3);
    expect(findings.map((finding) => finding.kind).sort()).toEqual(["cron", "function", "policy"]);
    expect(JSON.stringify(findings)).not.toContain("secret");
    expect(JSON.stringify(findings)).not.toContain("select run");
  });

  it("bounds detailed findings while retaining the total", () => {
    const result = boundedFindings(Array.from({ length: 12 }, (_, n) => ({ type: "drift", identity: String(n) })), 3);
    expect(result).toMatchObject({ total: 12, omitted: 9 });
    expect(result.shown).toHaveLength(3);
  });

  it("reports matching snapshots separately from unverified generated types and source SQL", () => {
    const categories = Object.fromEntries(CATALOG_QUERIES.map(({ name }) => [name, { status: "read", count: 0 }]));
    const objects = catalogObjects([
      { kind: "extension", identity: "pgcrypto", definition: "1" },
      { kind: "extension", identity: "pg_cron", definition: "1" },
      { kind: "event_trigger", identity: "ensure_rls", definition: "1" },
    ]);
    const environment = (name) => ({ name, history: local.map(({ version, name }) => row(version, name)), objects, categories, errors: [] });
    const report = buildReport(local, environment("production"), environment("staging"), { sourceFile: "src/types/database.ts", sha256: sha256("old"), schemaDerivedComparison: "unverified" }, null, cleanProvenance);
    expect(report.result).toBe("matching_snapshots");
    expect(report.sourceToHistoryBody.unverifiedRepresentationOrDifference.production).toBe(2);
    expect(report.generatedTypes.schemaDerivedComparison).toBe("unverified");
    expect(report.limitations.join(" ")).toMatch(/do not prove either matches the tracked migrations/);
  });

  it("does not report matching snapshots when all stored SQL payloads are NULL", () => {
    const categories = Object.fromEntries(CATALOG_QUERIES.map(({ name }) => [name, { status: "read", count: 0 }]));
    const objects = catalogObjects([
      { kind: "extension", identity: "pgcrypto", definition: "1" },
      { kind: "extension", identity: "pg_cron", definition: "1" },
      { kind: "event_trigger", identity: "ensure_rls", definition: "1" },
    ]);
    const environment = (name) => ({ name, history: local.map(({ version, name }) => row(version, name, null)), objects, categories, errors: [] });
    const report = buildReport(local, environment("production"), environment("staging"), { sourceFile: "src/types/database.ts", sha256: sha256("types"), schemaDerivedComparison: "unverified" }, null, cleanProvenance);
    expect(report.result).toBe("incomplete");
    expect(report.environments.staging.migrationHistory.storedSqlPayloadUnavailable).toBe(2);
    expect(report.findings.shown.filter((finding) => finding.type === "recorded_sql_mismatch")).toHaveLength(0);
  });

  it("reports staging generated-types drift even when history and catalogs match", () => {
    const categories = Object.fromEntries(CATALOG_QUERIES.map(({ name }) => [name, { status: "read", count: 0 }]));
    const objects = catalogObjects([
      { kind: "extension", identity: "pgcrypto", definition: "1" },
      { kind: "extension", identity: "pg_cron", definition: "1" },
      { kind: "event_trigger", identity: "ensure_rls", definition: "1" },
    ]);
    const environment = (name) => ({ name, history: local.map(({ version, name }) => row(version, name)), objects, categories, errors: [] });
    const types = {
      sourceFile: "src/types/database.ts", sha256: sha256("types"), schemaDerivedComparison: "different",
      production: { schemaBodyMatchesCheckedIn: true }, staging: { schemaBodyMatchesCheckedIn: false },
    };
    const report = buildReport(local, environment("production"), environment("staging"), types, null, cleanProvenance);
    expect(report.result).toBe("drift");
    expect(report.findings.shown.filter((finding) => finding.type === "generated_types_mismatch")).toEqual([
      expect.objectContaining({ environment: "staging", identity: "src/types/database.ts" }),
    ]);
  });

  it("marks missing catalog access incomplete rather than equal", () => {
    const categories = Object.fromEntries(CATALOG_QUERIES.map(({ name }) => [name, { status: "read", count: 0 }]));
    const empty = { name: "production", history: [], objects: new Map(), categories, errors: [] };
    const denied = { name: "staging", history: null, objects: new Map(), categories: { ...categories, policies: { status: "unavailable", count: null } }, errors: [{ category: "policies", code: "42501", reason: "insufficient_privilege" }] };
    const report = buildReport([], empty, denied, { sourceFile: "src/types/database.ts", sha256: "a", schemaDerivedComparison: "unverified" }, null, cleanProvenance);
    expect(report.result).toBe("incomplete");
    expect(report.environments.staging.errors).toEqual([{ category: "policies", code: "42501", reason: "insufficient_privilege" }]);
  });
});

describe("read-only database boundary", () => {
  it("requires explicit PostgreSQL URLs and rejects implicit or identical targets", () => {
    expect(() => explicitDbUrl("", "AA_SCHEMA_PARITY_PRODUCTION_URL")).toThrow(/required/);
    expect(() => explicitDbUrl("https://example.com", "AA_SCHEMA_PARITY_PRODUCTION_URL")).toThrow(/PostgreSQL URL/);
    expect(() => explicitDbUrl("postgresql://user:secret@host.test/db", "AA_SCHEMA_PARITY_PRODUCTION_URL")).toThrow(/sslmode=verify-full/);
    expect(() => explicitDbUrl("postgresql://user:secret@host.test/db?sslmode=require", "AA_SCHEMA_PARITY_PRODUCTION_URL")).toThrow(/sslmode=verify-full/);
    expect(explicitDbUrl("postgresql://user:secret@host.test/db?sslmode=verify-full", "AA_SCHEMA_PARITY_PRODUCTION_URL")).toContain("host.test/db");
    expect(explicitDbUrl("postgresql://user:secret@localhost/db", "AA_SCHEMA_PARITY_BASELINE_URL")).toContain("localhost/db");
  });

  it("records dirty working-tree provenance and a source digest independent of HEAD", () => {
    const calls = [];
    const fakeGit = (_cmd, args) => {
      calls.push(args.join(" "));
      if (args[0] === "rev-parse") return "7f08c4b30f77ed662c669b372424898d35c4cc3d\n";
      if (args.includes("--")) return "?? supabase/migrations/20261029120000_261_new.sql\n";
      return " M scripts/schema-parity.mjs\n?? supabase/migrations/20261029120000_261_new.sql\n";
    };
    const result = sourceProvenance("/tmp/repo", local, { sha256: sha256("types") }, fakeGit);
    expect(result).toMatchObject({ headSha: "7f08c4b30f77ed662c669b372424898d35c4cc3d", workingTreeClean: false, migrationInputsClean: false, generatedTypesSha256: sha256("types") });
    expect(result.migrationSourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toContain("status --porcelain=v1 --untracked-files=all -- supabase/migrations src/types/database.ts");
    const categories = Object.fromEntries(CATALOG_QUERIES.map(({ name }) => [name, { status: "read", count: 0 }]));
    const objects = catalogObjects([{ kind: "extension", identity: "pgcrypto", definition: "1" }, { kind: "extension", identity: "pg_cron", definition: "1" }, { kind: "event_trigger", identity: "ensure_rls", definition: "1" }]);
    const environment = (name) => ({ name, history: local.map(({ version, name }) => row(version, name)), objects, categories, errors: [] });
    const report = buildReport(local, environment("production"), environment("staging"), { sourceFile: "src/types/database.ts", sha256: sha256("types"), schemaDerivedComparison: "unverified" }, null, result);
    expect(report.result).toBe("incomplete");
    expect(report.gitSha).toBe(result.headSha);
    expect(report.sourceProvenance.migrationSourceDigest).toBe(result.migrationSourceDigest);
    expect(report.limitations.join(" ")).toMatch(/HEAD alone does not identify/);
  });

  it("wraps every SELECT in BEGIN READ ONLY and checks the server setting", async () => {
    const calls = [];
    const client = { query: async (sql) => {
      calls.push(sql);
      if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }] };
      return { rows: [] };
    } };
    await queryReadOnly(client, "select 1");
    expect(calls).toEqual(["BEGIN READ ONLY", "SHOW transaction_read_only", "select 1", "ROLLBACK"]);
    expect(CATALOG_QUERIES.every(({ sql }) => /^select\b/i.test(sql))).toBe(true);
    expect(HISTORY_SQL).toMatch(/^select\b/i);
  });

  it("refuses the query if the transaction is not read only", async () => {
    const calls = [];
    const client = { query: async (sql) => {
      calls.push(sql);
      if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "off" }] };
      return { rows: [] };
    } };
    await expect(queryReadOnly(client, "select secret from table")).rejects.toThrow(/not enforced/);
    expect(calls).not.toContain("select secret from table");
    expect(calls.at(-1)).toBe("ROLLBACK");
  });

  it("redacts connection failures instead of returning URL or server text", async () => {
    const dbUrl = "postgresql://alice:secret@private.example/db";
    class BrokenClient {
      constructor() {}
      async connect() { throw Object.assign(new Error(`failed ${dbUrl}`), { code: "ECONNREFUSED" }); }
    }
    const result = await inspectEnvironment("production", dbUrl, BrokenClient);
    expect(result.errors).toEqual([{ category: "connection", code: null, reason: "query_or_connection_failed" }]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("private.example");
  });
});
