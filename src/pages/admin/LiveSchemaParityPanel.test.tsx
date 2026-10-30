import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { LiveSchemaParityPanel } from "./LiveSchemaParityPanel";

const { readRuntime } = vi.hoisted(() => ({ readRuntime: vi.fn() }));
vi.mock("../../lib/readRuntime", () => ({ readRuntime }));

function validReport() {
  const sha = "7f08c4b30f77ed662c669b372424898d35c4cc3d";
  const digest = "a".repeat(64);
  const environment = { migrationHistory: { count: 279, head: "20261029140000", digest, storedSqlPayloadAvailable: 275, storedSqlPayloadUnavailable: 4 }, categories: { relations: { status: "read", count: 1 } }, errors: [] };
  return {
    ok: true, schemaVersion: 1, createdAt: new Date().toISOString(), gitSha: sha,
    sourceProvenance: { headSha: sha, workingTreeClean: true, migrationInputsClean: true, migrationSourceDigest: digest, generatedTypesSha256: digest },
    result: "drift", scope: "production_and_staging", localMigrations: { count: 280, head: "20261029140000", digest },
    environments: { production: environment, staging: { ...environment, migrationHistory: { ...environment.migrationHistory, storedSqlPayloadUnavailable: 277 } } },
    generatedTypes: { sourceFile: "src/types/database.ts", sha256: digest, schemaDerivedComparison: "matching" },
    sourceToHistoryBody: { provenEqualSingleStatement: { production: 0, staging: 0 }, unverifiedRepresentationOrDifference: { production: 280, staging: 280 }, storedSqlPayloadUnavailable: { production: 4, staging: 277 } },
    limitations: ["Staging stored SQL payloads are unavailable."],
    findings: { total: 1, shown: [{ type: "history_sql_payload_unavailable", environment: "staging", count: 277 }], omitted: 0 },
  };
}

beforeEach(() => { readRuntime.mockReset(); });

it("loads a server-authenticated report automatically and shows unavailable history payloads", async () => {
  readRuntime.mockResolvedValue(validReport());
  render(<LiveSchemaParityPanel />);
  await waitFor(() => expect(screen.getByText("Drift found")).toBeInTheDocument());
  expect(readRuntime).toHaveBeenCalledWith("/admin/schema-parity");
  expect(screen.getByText("277 unavailable")).toBeInTheDocument();
  expect(screen.queryByLabelText(/Import schema parity JSON/)).not.toBeInTheDocument();
});

it("fails closed to Unknown when runtime access or report validation fails", async () => {
  readRuntime.mockRejectedValue(new Error("Schema parity read access is not configured."));
  render(<LiveSchemaParityPanel />);
  await waitFor(() => expect(screen.getByText(/Schema parity unknown/)).toBeInTheDocument());
  expect(screen.getByRole("alert")).toHaveTextContent("Schema parity read access is not configured.");
});
