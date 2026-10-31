import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));

import { ApprovalCoveragePanel } from "./ApprovalCoveragePanel";

const recordedAt = "2026-10-30T10:00:00Z";
const rows = Array.from({ length: 34 }, (_, index) => ({
  class_id: index + 1,
  revision: 1,
  class_key: `class_${index + 1}`,
  title: `Decision class ${index + 1}`,
  source_state: index === 0 ? "blocked" : "missing",
  source_evidence: null,
  decision_state: "missing",
  decision_evidence: null,
  executor_state: "missing",
  executor_evidence: null,
  blocker: `Class ${index + 1} still needs an exact decision and executor check.`,
  recorded_at: recordedAt,
  overall_status: index === 0 ? "blocked" : "missing",
}));
const summary = {
  inventory_version: "b008-34-classes",
  expected_classes: 34,
  inventoried_classes: 34,
  operational_classes: 0,
  blocked_classes: 1,
  missing_classes: 33,
  fully_operational: false,
};

let classRows: typeof rows;
let summaryRow: typeof summary | null;
let readError: { message: string } | null;

beforeEach(() => {
  vi.clearAllMocks();
  classRows = rows.map((row) => ({ ...row }));
  summaryRow = { ...summary };
  readError = null;
  from.mockImplementation((table: string) => {
    const query = {
      select: () => query,
      order: async () => ({ data: classRows, error: readError }),
      maybeSingle: async () => ({ data: summaryRow, error: readError }),
    };
    if (!["approval_class_coverage_v6", "approval_coverage_summary_v6"].includes(table)) {
      throw new Error(`Unexpected table ${table}`);
    }
    return query;
  });
});

describe("approval class coverage", () => {
  it("shows all 34 recorded class states and never presents them as live proof", async () => {
    render(<ApprovalCoveragePanel />);
    expect(await screen.findByText(/Recorded coverage: 0 of 34 classes marked operational/))
      .toBeInTheDocument();
    expect(screen.getByText(/do not verify live accounts, current permissions/))
      .toBeInTheDocument();
    await userEvent.click(screen.getByText("Inspect all 34 class records"));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(35);
    expect(within(table).getByRole("rowheader", { name: /Decision class 34/ })).toBeInTheDocument();
    expect(within(table).getByText(/Class 1 still needs an exact decision/))
      .toBeInTheDocument();
    expect(from).toHaveBeenCalledWith("approval_class_coverage_v6");
    expect(from).toHaveBeenCalledWith("approval_coverage_summary_v6");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed on duplicate or missing class IDs", async () => {
    classRows[33] = { ...classRows[33], class_id: 1 };
    render(<ApprovalCoveragePanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Coverage is unavailable or inconsistent");
    expect(screen.queryByText(/Recorded coverage:/)).not.toBeInTheDocument();
  });

  it("fails closed on duplicate class keys even with 34 distinct IDs", async () => {
    classRows[33] = { ...classRows[33], class_key: "class_1" };
    render(<ApprovalCoveragePanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Coverage is unavailable or inconsistent");
    expect(screen.queryByText(/Recorded coverage:/)).not.toBeInTheDocument();
  });

  it("fails closed when the summary disagrees with the class records", async () => {
    summaryRow = { ...summary, operational_classes: 1, blocked_classes: 0 };
    render(<ApprovalCoveragePanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No completion count can be shown");
    expect(screen.queryByText(/Recorded coverage:/)).not.toBeInTheDocument();
  });

  it("fails closed when a verified state has no evidence", async () => {
    classRows[0] = { ...classRows[0], source_state: "verified", source_evidence: null,
      overall_status: "blocked" };
    render(<ApprovalCoveragePanel />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("shows an unavailable state on read denial and allows retry", async () => {
    readError = { message: "RLS denied" };
    render(<ApprovalCoveragePanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Coverage is unavailable or inconsistent");
    expect(screen.queryByText(/Recorded coverage:/)).not.toBeInTheDocument();
    readError = null;
    await userEvent.click(screen.getByRole("button", { name: "Refresh coverage" }));
    expect(await screen.findByText(/Recorded coverage: 0 of 34 classes marked operational/))
      .toBeInTheDocument();
  });
});
