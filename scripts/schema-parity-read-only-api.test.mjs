// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { CATALOG_QUERIES, HISTORY_SQL } from "./schema-parity.mjs";
import {
  explicitProjectRefs, scopedReadToken, readOnlyApiQuery, inspectReadOnlyApi,
  generatedSchemaBody, generatedTypeStatus, readLiveTypes, requireVerifiedLiveTypes,
} from "./schema-parity-read-only-api.mjs";

const prod = "bancbdztffokwiifzoiv";
const stage = "vmmertwoboqiazcsougw";
const token = `sbp_fc${"x".repeat(24)}`;

describe("Management API read-only transport", () => {
  it("requires two explicit distinct refs and a fine-grained token", () => {
    expect(explicitProjectRefs(prod, stage)).toEqual({ production: prod, staging: stage });
    expect(() => explicitProjectRefs(prod, prod)).toThrow(/must differ/);
    expect(() => explicitProjectRefs("", stage)).toThrow(/Two explicit/);
    expect(() => scopedReadToken("sbp_legacy")) .toThrow(/fine-grained/);
    expect(scopedReadToken(token)).toBe(token);
  });

  it("uses only the dedicated read-only endpoint and never returns token or raw error text", async () => {
    const fetchImpl = vi.fn(async (_url, options) => {
      expect(options.method).toBe("POST");
      expect(options.headers.Authorization).toBe(`Bearer ${token}`);
      expect(JSON.parse(options.body)).toEqual({ query: HISTORY_SQL });
      return { ok: true, json: async () => [{ version: "20261029140000" }] };
    });
    expect(await readOnlyApiQuery(prod, HISTORY_SQL, token, fetchImpl)).toEqual([{ version: "20261029140000" }]);
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.supabase.com/v1/projects/${prod}/database/query/read-only`);
    await expect(readOnlyApiQuery(prod, "delete from public.profiles", token, fetchImpl)).rejects.toThrow(/requires_one_select/);
    await expect(readOnlyApiQuery(prod, "select 1; drop table public.profiles", token, fetchImpl)).rejects.toThrow(/requires_one_select/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("marks each failed catalog category unavailable while preserving successful reads", async () => {
    const fetchImpl = vi.fn(async (_url, options) => {
      const { query } = JSON.parse(options.body);
      if (query === HISTORY_SQL) return { ok: true, json: async () => [{ version: "20261029140000", name: "263_auth_signup_role_hardening", statement_count: 0, stored_sql_md5: null, single_statement_trimmed_md5: null }] };
      if (query.includes("to_regclass")) return { ok: true, json: async () => [{ present: true }] };
      if (query === CATALOG_QUERIES.find((entry) => entry.name === "policies").sql) return { ok: false, status: 403 };
      return { ok: true, json: async () => [] };
    });
    const snapshot = await inspectReadOnlyApi("production", prod, token, fetchImpl);
    expect(snapshot.history[0]).toMatchObject({ version: "20261029140000", storedSqlMd5: null });
    expect(snapshot.categories.policies).toEqual({ status: "unavailable", count: null });
    expect(snapshot.errors).toEqual([{ category: "policies", code: null, reason: "management_api_http_403" }]);
    expect(snapshot.categories.functions).toEqual({ status: "read", count: 0 });
    expect(JSON.stringify(snapshot)).not.toContain(token);
  });

  it("compares schema body while treating changed generator format as unknown", async () => {
    const checkedIn = "export type Database = {\n  graphql_public: { same: true }\n}\ntype DatabaseWithoutInternals = Omit<Database, never>\n";
    const generated = `/* newer helper */\n${checkedIn.replace("export type Database", "export type Database")}`;
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ types: generated }) }));
    const info = await readLiveTypes(prod, token, checkedIn, fetchImpl);
    expect(info.schemaBodyMatchesCheckedIn).toBe(true);
    expect(info.exactFileMatchesCheckedIn).toBe(false);
    expect(generatedSchemaBody("new format without schema markers")).toBeNull();
  });

  it("never calls generated types matching when staging differs or either read is unknown", () => {
    const matching = { schemaBodyMatchesCheckedIn: true };
    const different = { schemaBodyMatchesCheckedIn: false };
    expect(generatedTypeStatus(matching, matching)).toBe("matching");
    expect(generatedTypeStatus(matching, different)).toBe("different");
    expect(generatedTypeStatus(different, matching)).toBe("different");
    expect(generatedTypeStatus(matching, { error: "management_api_http_403" })).toBe("unverified");
  });

  it("cannot call a live report green when either type body has an unrecognized format", () => {
    const report = { result: "matching_snapshots", generatedTypes: { schemaDerivedComparison: generatedTypeStatus({ schemaBodyMatchesCheckedIn: true }, { schemaBodyMatchesCheckedIn: null }) }, limitations: [] };
    requireVerifiedLiveTypes(report);
    expect(report.result).toBe("incomplete");
    expect(report.limitations).toContainEqual(expect.stringMatching(/schema-body format could not be recognized/));
  });
});
