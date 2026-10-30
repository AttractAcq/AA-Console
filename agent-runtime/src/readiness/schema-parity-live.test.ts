import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../config.js";
import manifest from "./schema-parity-manifest.json" with { type: "json" };
import { collectSchemaParity, schemaParityConfig } from "./schema-parity-live.js";

const token = `sbp_fc${"x".repeat(24)}`;
const refs = { production: "bancbdztffokwiifzoiv", staging: "vmmertwoboqiazcsougw" };
const config = { supabaseUrl: `https://${refs.production}.supabase.co`, schemaParityReadToken: token, schemaParityProductionRef: refs.production, schemaParityStagingRef: refs.staging } as RuntimeConfig;

beforeEach(() => { process.env.RAILWAY_GIT_COMMIT_SHA = "7f08c4b30f77ed662c669b372424898d35c4cc3d"; });

describe("live schema parity", () => {
  it("requires explicit, distinct project refs and a fine-grained read token", () => {
    expect(schemaParityConfig(config)).toEqual({ token, refs });
    expect(schemaParityConfig({ ...config, schemaParityReadToken: "legacy-full-access" })).toBeNull();
    expect(schemaParityConfig({ ...config, schemaParityStagingRef: refs.production })).toBeNull();
    expect(schemaParityConfig({ ...config, schemaParityStagingRef: null })).toBeNull();
    expect(schemaParityConfig({ ...config, supabaseUrl: `https://${refs.staging}.supabase.co` })).toBeNull();
  });

  it("uses only fixed read-only SQL, redacts definitions, and classifies NULL histories as unavailable", async () => {
    const typeSource = await readFile(new URL("../../../src/types/database.ts", import.meta.url), "utf8");
    const calls: { url: string; query?: string }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const address = String(url);
      const body = options?.body ? JSON.parse(String(options.body)) as { query: string } : null;
      calls.push({ url: address, query: body?.query });
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      if (address.includes("/types/typescript")) return { ok: true, json: async () => ({ types: typeSource }) } as Response;
      expect(address).toMatch(/\/database\/query\/read-only$/);
      expect(body?.query).toMatch(/^select\b/i);
      const stage = address.includes(refs.staging);
      if (body?.query === manifest.historySql) return { ok: true, json: async () => manifest.localMigrations.map((row) => ({
        version: row.version, name: row.name, statement_count: 1,
        stored_sql_md5: stage ? null : "known", single_statement_trimmed_md5: stage ? null : row.trimmedMd5,
      })) } as Response;
      if (body?.query.includes("to_regclass")) return { ok: true, json: async () => [{ present: true }] } as Response;
      if (body?.query.includes("from pg_extension e")) return { ok: true, json: async () => [
        { kind: "extension", identity: "pgcrypto", definition: { version: "1" } },
        { kind: "extension", identity: "pg_cron", definition: { version: "1" } },
      ] } as Response;
      if (body?.query.includes("from pg_event_trigger e")) return { ok: true, json: async () => [
        { kind: "event_trigger", identity: "ensure_rls", definition: { event: "ddl_command_end" } },
      ] } as Response;
      return { ok: true, json: async () => [] } as Response;
    }) as unknown as typeof fetch;
    const report = await collectSchemaParity(config, fetchImpl);
    expect(report.result).toBe("incomplete");
    expect(report.environments.staging.migrationHistory?.storedSqlPayloadUnavailable).toBe(manifest.localMigrations.length);
    expect(report.findings.shown.filter((finding) => finding.type === "recorded_sql_mismatch")).toHaveLength(0);
    expect(report.findings.shown.filter((finding) => finding.type === "history_sql_payload_unavailable")).toHaveLength(1);
    expect(report.access.projectRefs).toEqual(refs);
    expect(report.sourceProvenance).toMatchObject({
      headSha: process.env.RAILWAY_GIT_COMMIT_SHA,
      workingTreeClean: null,
      migrationInputsClean: null,
    });
    expect(report.generatedTypes.schemaDerivedComparison).toBe("matching");
    expect(JSON.stringify(report)).not.toContain(token);
    expect(JSON.stringify(report)).not.toContain("ddl_command_end");
    expect(calls.filter((call) => call.url.includes("/database/query/read-only"))).toHaveLength(26);
  });

  it("reports staging type drift when migration histories and catalogs otherwise match", async () => {
    const typeSource = await readFile(new URL("../../../src/types/database.ts", import.meta.url), "utf8");
    const changedStagingTypes = typeSource.replace("  graphql_public: {", "  graphql_public: { /* staging drift */");
    expect(changedStagingTypes).not.toBe(typeSource);
    const fetchImpl = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const address = String(url);
      const body = options?.body ? JSON.parse(String(options.body)) as { query: string } : null;
      const stage = address.includes(refs.staging);
      if (address.includes("/types/typescript")) return { ok: true, json: async () => ({ types: stage ? changedStagingTypes : typeSource }) } as Response;
      expect(address).toMatch(/\/database\/query\/read-only$/);
      if (body?.query === manifest.historySql) return { ok: true, json: async () => manifest.localMigrations.map((row) => ({
        version: row.version, name: row.name, statement_count: 1,
        stored_sql_md5: "known", single_statement_trimmed_md5: row.trimmedMd5,
      })) } as Response;
      if (body?.query.includes("to_regclass")) return { ok: true, json: async () => [{ present: true }] } as Response;
      if (body?.query.includes("from pg_extension e")) return { ok: true, json: async () => [
        { kind: "extension", identity: "pgcrypto", definition: { version: "1" } },
        { kind: "extension", identity: "pg_cron", definition: { version: "1" } },
      ] } as Response;
      if (body?.query.includes("from pg_event_trigger e")) return { ok: true, json: async () => [
        { kind: "event_trigger", identity: "ensure_rls", definition: { event: "ddl_command_end" } },
      ] } as Response;
      return { ok: true, json: async () => [] } as Response;
    }) as unknown as typeof fetch;
    const report = await collectSchemaParity(config, fetchImpl);
    expect(report.result).toBe("drift");
    expect(report.generatedTypes.schemaDerivedComparison).toBe("different");
    expect(report.findings.shown.filter((finding) => finding.type === "generated_types_mismatch")).toEqual([
      expect.objectContaining({ environment: "staging", identity: "src/types/database.ts" }),
    ]);
    expect(report.findings.shown).toHaveLength(1);
  });
});
