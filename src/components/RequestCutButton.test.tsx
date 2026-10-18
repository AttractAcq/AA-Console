import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("../lib/supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import { RequestCutButton } from "./RequestCutButton";
import type { CutState } from "../lib/reelShots";

const state = (over: Partial<CutState> = {}): CutState => ({
  status: "ready",
  detail: "All 3 clips on file.",
  canRequest: true,
  ...over,
});

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: "job-1", error: null });
});

describe("asking for a cut", () => {
  it("calls the one function migration 141 exposed", async () => {
    // It existed for two days with nothing calling it, which is the same as
    // the cut not existing for anybody without SQL access.
    const onRequested = vi.fn();
    render(
      <RequestCutButton assetId="asset-1" state={state()} onRequested={onRequested} onError={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /cut the reel/i }));
    await waitFor(() => expect(onRequested).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledWith("request_video_edit", { p_asset_id: "asset-1" });
  });

  it("shows what the database said when it refused", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "A cut of this reel is already queued or running." } });
    const onError = vi.fn();
    const onRequested = vi.fn();
    render(
      <RequestCutButton assetId="asset-1" state={state()} onRequested={onRequested} onError={onError} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /cut the reel/i }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("A cut of this reel is already queued or running."));
    expect(onRequested).not.toHaveBeenCalled();
  });

  it("offers nothing while a cut is running", async () => {
    render(
      <RequestCutButton
        assetId="asset-1"
        state={state({ status: "running", detail: "Being cut now.", canRequest: false })}
        onRequested={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Being cut now.")).toBeInTheDocument();
  });

  it("offers nothing once the cut is on file", () => {
    render(
      <RequestCutButton
        assetId="asset-1"
        state={state({ status: "cut", detail: "Cut on file.", canRequest: false })}
        onRequested={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says it is a second attempt after a failure, and shows why the first failed", () => {
    render(
      <RequestCutButton
        assetId="asset-1"
        state={state({ status: "failed", detail: "Last cut failed: Shot 2 has no clip. 2 of 3 clips on file." })}
        onRequested={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /cut it again/i })).toBeInTheDocument();
    expect(screen.getByText(/Shot 2 has no clip/)).toBeInTheDocument();
  });

  it("still offers the cut with clips missing, and names the gap", () => {
    render(
      <RequestCutButton
        assetId="asset-1"
        state={state({ status: "incomplete", detail: "1 of 3 clips on file." })}
        onRequested={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /cut the reel/i })).toBeInTheDocument();
    expect(screen.getByText("1 of 3 clips on file.")).toBeInTheDocument();
  });

  it("cannot be pressed twice into the same request", async () => {
    let settle: (value: unknown) => void = () => {};
    rpc.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    render(<RequestCutButton assetId="asset-1" state={state()} onRequested={vi.fn()} onError={vi.fn()} />);
    const button = screen.getByRole("button", { name: /cut the reel/i });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    settle({ data: "job-1", error: null });
  });
});
