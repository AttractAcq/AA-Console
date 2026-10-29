import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SchemaParityPanel, parseSchemaParityReport, type SchemaParityReport } from "./SchemaParityPanel";

const categories: SchemaParityReport["environments"][string]["categories"] = { functions: { status: "read", count: 2 }, policies: { status: "read", count: 1 }, cron: { status: "unavailable", count: null } };

function report(): SchemaParityReport {
  return {
    schemaVersion: 1,
    createdAt: "2026-10-29T21:00:00.000Z",
    gitSha: "7f08c4b30f77ed662c669b372424898d35c4cc3d",
    sourceProvenance: { headSha: "7f08c4b30f77ed662c669b372424898d35c4cc3d", workingTreeClean: true, migrationInputsClean: true, migrationSourceDigest: "a".repeat(64), generatedTypesSha256: "d".repeat(64) },
    result: "matching_snapshots",
    scope: "production_and_staging",
    localMigrations: { count: 276, head: "20261025233000", digest: "a".repeat(64) },
    environments: {
      production: { migrationHistory: { count: 276, head: "20261025233000", digest: "b" }, categories, errors: [] },
      staging: { migrationHistory: { count: 276, head: "20261025233000", digest: "c" }, categories, errors: [] },
    },
    generatedTypes: { sourceFile: "src/types/database.ts", sha256: "d".repeat(64), schemaDerivedComparison: "unverified" },
    sourceToHistoryBody: { provenEqualSingleStatement: { production: 2, staging: 2 }, unverifiedRepresentationOrDifference: { production: 274, staging: 274 } },
    limitations: ["Without a clean replay baseline, matching snapshots do not prove source equivalence."],
    findings: { total: 0, shown: [], omitted: 0 },
  };
}

describe("SchemaParityPanel", () => {
  it("shows Unknown until an admin supplies a validated report", () => {
    render(<SchemaParityPanel />);
    expect(screen.getByText(/Schema parity unknown/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Import schema parity JSON/)).toBeInTheDocument();
  });

  it("shows migration heads, category uncertainty and source limits without claiming full parity", () => {
    render(<SchemaParityPanel report={report()} />);
    expect(screen.getByText("Observed snapshots match")).toBeInTheDocument();
    expect(screen.getByText(/tracked-source equivalence is unproven/)).toBeInTheDocument();
    expect(screen.getByText(/Generated types: unverified/)).toBeInTheDocument();
    expect(screen.getAllByText("20261025233000")).toHaveLength(3);
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
  });

  it("shows object drift but redacts a suspicious imported identity", () => {
    const drift = report();
    drift.result = "drift";
    drift.findings = { total: 1, shown: [{ type: "catalog_definition_mismatch", identity: "postgresql://user:password@db/secret", kind: "function", environment: "production" }], omitted: 0 };
    render(<SchemaParityPanel report={drift} />);
    expect(screen.getByText("Drift found")).toBeInTheDocument();
    expect(screen.getByText(/catalog_definition_mismatch/)).toBeInTheDocument();
    expect(screen.queryByText(/postgresql:\/\/user/)).not.toBeInTheDocument();
    expect(screen.getByText(/\[redacted\]/)).toBeInTheDocument();
  });

  it("shows each finding's suggested next action while redacting unsafe or oversized text", () => {
    const drift = report();
    drift.result = "drift";
    drift.findings = { total: 3, shown: [
      { type: "catalog_definition_mismatch", identity: "public.safe_function", nextAction: "Review the function definition and migration lineage." },
      { type: "remote_only", version: "20261029120000", nextAction: "Send credentials to https://example.invalid/password" },
      { type: "missing_local", version: "20261029130000", nextAction: "x".repeat(241) },
    ], omitted: 0 };

    render(<SchemaParityPanel report={drift} />);
    expect(screen.getByText("Next action: Review the function definition and migration lineage.")).toBeInTheDocument();
    expect(screen.getAllByText("Next action: [redacted]")).toHaveLength(2);
    expect(screen.queryByText(/example\.invalid/)).not.toBeInTheDocument();
    expect(screen.queryByText(/x{241}/)).not.toBeInTheDocument();

    drift.findings.shown[0].nextAction = 42 as unknown as string;
    expect(parseSchemaParityReport(drift)).toBeNull();
  });

  it("shows dirty checkout provenance and its content digest instead of treating HEAD as complete identity", () => {
    const dirty = report();
    dirty.result = "incomplete";
    dirty.sourceProvenance.workingTreeClean = false;
    dirty.sourceProvenance.migrationInputsClean = false;
    render(<SchemaParityPanel report={dirty} />);
    expect(screen.getByText("Verification incomplete")).toBeInTheDocument();
    expect(screen.getByText(/working tree dirty/)).toBeInTheDocument();
    expect(screen.getByText(/HEAD alone does not identify this audited checkout/)).toBeInTheDocument();
    expect(screen.getByText(/Migration-source SHA-256:/)).toHaveTextContent("a".repeat(64));
    expect(screen.getByText(/Migration inputs: dirty/)).toBeInTheDocument();
  });

  it("rejects an invalid report instead of rendering a plausible pass", () => {
    const malformed = { ...report(), environments: { production: {}, staging: {} } };
    expect(parseSchemaParityReport(malformed)).toBeNull();
    render(<SchemaParityPanel report={malformed} />);
    expect(screen.getByText(/failed validation/)).toBeInTheDocument();
    expect(screen.getByText(/Schema parity unknown/)).toBeInTheDocument();
  });

  it("imports a redacted JSON file locally without making a database request", async () => {
    render(<SchemaParityPanel />);
    const file = new File([JSON.stringify(report())], "parity.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => JSON.stringify(report()) });
    fireEvent.change(screen.getByLabelText(/Import schema parity JSON/), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText("Observed snapshots match")).toBeInTheDocument());
  });
});
