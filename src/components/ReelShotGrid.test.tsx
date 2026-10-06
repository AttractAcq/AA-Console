import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReelShotGrid } from "./ReelShotGrid";
import type { ReelMasterView } from "../lib/reelShots";

vi.mock("../lib/supabase", () => ({ supabase: { rpc: vi.fn() } }));

const master = (over: Partial<ReelMasterView> = {}): ReelMasterView => ({
  briefId: "brief-1",
  title: "How it works",
  briefRef: "BR-9",
  formatCode: "F6",
  briefStatus: "in_production",
  planProblem: null,
  plannedShots: [
    {
      position: 1,
      beat: "Name the mechanism",
      durationLabel: "3s",
      source: "Generated",
      motion: "pending",
      still: "No still",
      clip: "No clip",
    },
  ],
  assets: [],
  ...over,
});

describe("ReelShotGrid", () => {
  it("shows the shot plan and says there is nothing to approve yet", () => {
    render(<ReelShotGrid masters={[master()]} onChanged={vi.fn()} onError={vi.fn()} />);
    expect(screen.getByText("How it works")).toBeInTheDocument();
    expect(screen.getByText("Name the mechanism")).toBeInTheDocument();
    expect(screen.getByText(/Nothing to approve until a master exists/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Approve$/ })).not.toBeInTheDocument();
  });

  it("offers approve on a pending master", () => {
    render(
      <ReelShotGrid
        masters={[
          master({
            assets: [
              {
                id: "asset-1",
                title: "Cut",
                refNumber: "MD-1",
                reviewStatus: "pending",
                shots: master().plannedShots,
                cut: { status: "incomplete" as const, detail: "0 of 1 clips on file.", canRequest: true },
              },
            ],
          }),
        ]}
        onChanged={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^Approve$/ })).toBeInTheDocument();
    expect(screen.getByText("MD-1 · Cut")).toBeInTheDocument();
  });

  it("surfaces a plan that is not shots", () => {
    render(
      <ReelShotGrid
        masters={[master({ planProblem: "Shot 1 of the stored plan is not a shot record.", plannedShots: [] })]}
        onChanged={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/not a shot record/);
  });
});
