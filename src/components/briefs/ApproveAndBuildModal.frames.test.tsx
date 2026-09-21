import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApproveAndBuildModal } from "./ApproveAndBuildModal";

const rpc = vi.fn();

vi.mock("../../lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => ({
      select: () => ({
        in: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [] }) }) }),
      }),
    }),
    storage: { from: () => ({ upload: vi.fn(), createSignedUrl: vi.fn() }) },
  },
}));

const brief = (content_format: string) => ({
  id: "b1",
  title: "Five reasons",
  body: "the brief",
  media_type: "image" as const,
  content_format,
  brief_ref: "BR-1",
  status: "approved",
});

const open = (format: string) =>
  render(
    <MemoryRouter>
      <ApproveAndBuildModal brief={brief(format)} open onClose={() => {}} onDone={() => {}} />
    </MemoryRouter>,
  );

const chooseAI = () => fireEvent.click(screen.getByText("AI").closest("button")!);

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ error: null });
});

describe("the frame ask on Approve & Build", () => {
  it("is not offered for a single, which has no frames", () => {
    open("single");
    chooseAI();
    expect(screen.queryByText(/The set/)).toBeNull();
  });

  it("is offered for a carousel", () => {
    open("carousel");
    chooseAI();
    expect(screen.getByText(/The set/)).toBeTruthy();
    expect(screen.getByPlaceholderText(/the agent decides/i)).toBeTruthy();
  });

  it("sends neither field when nothing is asked for", async () => {
    open("carousel");
    chooseAI();
    fireEvent.click(screen.getByText("Generate"));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("p_frame_count");
    expect(args).not.toHaveProperty("p_frame_plan");
  });

  it("sends the count when only a count is typed", async () => {
    open("carousel");
    chooseAI();
    fireEvent.change(screen.getByPlaceholderText(/the agent decides/i), { target: { value: "5" } });
    fireEvent.click(screen.getByText("Generate"));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_frame_count).toBe(5);
    expect(args).not.toHaveProperty("p_frame_plan");
  });

  // The plan carries the count, so sending both risks a disagreement the
  // RPC would refuse.
  it("sends the plan alone when one is typed, not the plan and a count", async () => {
    open("carousel");
    chooseAI();
    fireEvent.change(screen.getByPlaceholderText(/the agent decides/i), { target: { value: "9" } });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hook\nobjection\n\nproof\n" },
    });
    fireEvent.click(screen.getByText("Generate"));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_frame_plan).toEqual(["hook", "objection", "proof"]);
    expect(args).not.toHaveProperty("p_frame_count");
  });

  it("refuses to submit a plan outside the bounds, before the round trip", async () => {
    open("carousel");
    chooseAI();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "only one frame" } });
    expect(screen.getByText(/runs from 2 to 10 frames/)).toBeTruthy();
    expect((screen.getByText("Generate") as HTMLButtonElement).disabled).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("the shape a story can be", () => {
  it("offers a story only portrait, because 116 refuses the rest", () => {
    open("story");
    chooseAI();
    expect(screen.getByText("Portrait")).toBeTruthy();
    expect(screen.queryByText("Landscape")).toBeNull();
    expect(screen.queryByText("Square")).toBeNull();
  });

  it("leaves a carousel free to be any of them", () => {
    open("carousel");
    chooseAI();
    for (const shape of ["Portrait", "Square", "Landscape"]) {
      expect(screen.getByText(shape)).toBeTruthy();
    }
  });

  it("leaves a single free to be any of them", () => {
    open("single");
    chooseAI();
    for (const shape of ["Portrait", "Square", "Landscape"]) {
      expect(screen.getByText(shape)).toBeTruthy();
    }
  });

  it("sends portrait for a story", async () => {
    open("story");
    chooseAI();
    fireEvent.click(screen.getByText("Generate"));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect((rpc.mock.calls[0][1] as Record<string, unknown>).p_size).toBe("1024x1536");
  });
});
