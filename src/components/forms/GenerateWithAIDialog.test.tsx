import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GenerateWithAIDialog } from "./GenerateWithAIDialog";

const runtime = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../../lib/callRuntime", () => ({ callRuntime: runtime.call }));

const props = {
  title: "Draft with AI",
  intro: "Prepare a draft.",
  label: "Steer",
  placeholder: "Notes",
  endpoint: "/draft",
  payload: { clientId: "client-1" },
  requireNotes: false,
};

beforeEach(() => { runtime.call.mockReset(); });

describe("AI draft cancellation", () => {
  it("ignores a response after Cancel, clears private notes, and accepts a new request", async () => {
    const pending: Array<(result: { draft: { ask: string } }) => void> = [];
    runtime.call.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    const onClose = vi.fn();
    const onGenerated = vi.fn();
    const { rerender } = render(<GenerateWithAIDialog<{ ask: string }>
      {...props} open onClose={onClose} onGenerated={onGenerated} />);

    fireEvent.change(screen.getByLabelText("Steer"), { target: { value: "private steering" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(runtime.call).toHaveBeenCalledWith("/draft", { clientId: "client-1", notes: "private steering" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<GenerateWithAIDialog<{ ask: string }> {...props} open={false}
      onClose={onClose} onGenerated={onGenerated} />);
    rerender(<GenerateWithAIDialog<{ ask: string }> {...props} open
      onClose={onClose} onGenerated={onGenerated} />);
    expect(screen.getByLabelText("Steer")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    await act(async () => { pending[1]({ draft: { ask: "fresh" } }); });
    expect(onGenerated).toHaveBeenCalledExactlyOnceWith({ ask: "fresh" }, undefined, undefined);
    await act(async () => { pending[0]({ draft: { ask: "stale" } }); });
    expect(onGenerated).toHaveBeenCalledTimes(1);
  });

  it("ignores a response when the parent hides the dialog before it resolves", async () => {
    let resolve!: (result: { draft: { ask: string } }) => void;
    runtime.call.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const onGenerated = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(<GenerateWithAIDialog<{ ask: string }>
      {...props} open onClose={onClose} onGenerated={onGenerated} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    rerender(<GenerateWithAIDialog<{ ask: string }> {...props} open={false}
      onClose={onClose} onGenerated={onGenerated} />);
    await act(async () => { resolve({ draft: { ask: "late" } }); });
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it("drops an in-flight result and private notes when the subject changes", async () => {
    const pending: Array<(result: { draft: { ask: string } }) => void> = [];
    runtime.call.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    const onGenerated = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(<GenerateWithAIDialog<{ ask: string }>
      {...props} open onClose={onClose} onGenerated={onGenerated} />);
    fireEvent.change(screen.getByLabelText("Steer"), { target: { value: "client-one private notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    rerender(<GenerateWithAIDialog<{ ask: string }> {...props} open
      payload={{ clientId: "client-2" }} onClose={onClose} onGenerated={onGenerated} />);
    expect(screen.getByLabelText("Steer")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    await act(async () => { pending[0]({ draft: { ask: "old client" } }); });
    expect(onGenerated).not.toHaveBeenCalled();
    await act(async () => { pending[1]({ draft: { ask: "new client" } }); });
    expect(onGenerated).toHaveBeenCalledExactlyOnceWith({ ask: "new client" }, undefined, undefined);
  });
});
