import { describe, expect, it } from "vitest";
import { ScopeError, ruleFor, tableNames, TABLES, type MasterScope } from "./scope.js";

const company: MasterScope = { kind: "company" };
const client: MasterScope = { kind: "client", clientId: "11111111-1111-1111-1111-111111111111" };

describe("master AI scope", () => {
  it("denies an unknown table rather than defaulting it open", () => {
    expect(() => ruleFor("some_new_table", client, "read")).toThrow(ScopeError);
    expect(() => ruleFor("some_new_table", company, "read")).toThrow(ScopeError);
  });

  it("keeps a client conversation out of global tables", () => {
    for (const table of ["profiles", "team_messages", "finance_periods", "contract_payments"]) {
      expect(() => ruleFor(table, client, "read"), table).toThrow(ScopeError);
      expect(() => ruleFor(table, client, "write"), table).toThrow(ScopeError);
    }
  });

  it("lets a company conversation reach those same tables", () => {
    for (const table of ["profiles", "team_messages", "finance_periods"]) {
      expect(() => ruleFor(table, company, "read"), table).not.toThrow();
    }
  });

  it("never lets a client conversation write a table it cannot read", () => {
    // Write-without-read is always a mistake: it means a rule was written
    // for company scope but applied to client scope.
    for (const [name, rule] of Object.entries(TABLES)) {
      if (rule.clientWrite) expect(rule.clientRead, `${name} is writable but not readable`).toBe(true);
    }
  });

  it("refuses to write a view in either scope", () => {
    for (const scope of [client, company]) {
      expect(() => ruleFor("approvals_queue", scope, "write")).toThrow(/view/i);
      expect(() => ruleFor("agent_stats", scope, "write")).toThrow(/view/i);
    }
  });

  it("routes agent runs through the tool rather than the queue table", () => {
    expect(() => ruleFor("agent_jobs", client, "write")).toThrow(/run_agent/);
    expect(() => ruleFor("agent_jobs", client, "read")).not.toThrow();
  });

  it("protects credentials and login links from a client conversation's writes", () => {
    expect(() => ruleFor("client_integrations", client, "write")).toThrow(ScopeError);
    expect(() => ruleFor("client_users", client, "write")).toThrow(ScopeError);
  });

  it("scopes the clients table by its own id, not by client_id", () => {
    const rule = ruleFor("clients", client, "read");
    expect(rule.scope).toEqual({ by: "column", column: "id" });
  });

  it("offers a client conversation strictly fewer tables than a company one", () => {
    expect(tableNames(client, "read").length).toBeLessThan(tableNames(company, "read").length);
    expect(tableNames(client, "write").length).toBeLessThan(tableNames(company, "write").length);
  });

  it("gives every table a scope rule that can actually be applied", () => {
    for (const [name, rule] of Object.entries(TABLES)) {
      if (rule.scope.by === "parent") {
        expect(TABLES[rule.scope.parentTable], `${name} parent missing`).toBeDefined();
      }
      if (rule.clientRead && rule.scope.by === "global") {
        // A global table readable in client scope is unfiltered by design;
        // it must hold nothing client-specific.
        expect(["agents", "record_templates", "sops", "campaign_totals", "agent_runtime_status"]).toContain(name);
      }
    }
  });
});
