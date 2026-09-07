import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: { rpc } }));

import { RepurposeModal } from "./RepurposeModal";

function show(over: Partial<Parameters<typeof RepurposeModal>[0]> = {}) {
  const onClose = over.onClose ?? vi.fn();
  const onQueued = over.onQueued ?? vi.fn();
  render(
    <RepurposeModal
      assetId="asset-1"
      assetTitle="Show Me The Ordinary One"
      open
      onClose={onClose}
      onQueued={onQueued}
      {...over}
    />,
  );
  return { onClose, onQueued };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ error: null });
});

describe("RepurposeModal — what it promises", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <RepurposeModal assetId="a" assetTitle="t" open={false} onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // The honesty that shapes the whole feature: AA cannot cut video, so this
  // must not read as though a finished reel is coming.
  it("says a brief is produced, not a finished file", () => {
    show();
    expect(screen.getByText(/production brief, not a finished file/i)).toBeInTheDocument();
  });

  it("says what each format actually produces", () => {
    show();
    expect(screen.getAllByText("video brief")).toHaveLength(3);
    expect(screen.getAllByText("image brief")).toHaveLength(3);
    expect(screen.getAllByText("text brief")).toHaveLength(2);
  });
});

describe("RepurposeModal — choosing formats", () => {
  it("will not queue nothing", () => {
    show();
    expect(screen.getByRole("button", { name: /^Write/ })).toBeDisabled();
  });

  it("sends exactly the formats ticked", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByLabelText(/Reel/));
    await user.click(screen.getByLabelText(/Email/));
    await user.click(screen.getByRole("button", { name: /^Write 2 briefs$/ }));

    await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    expect(rpc).toHaveBeenCalledWith("repurpose_asset", {
      p_asset_id: "asset-1",
      p_formats: ["reel", "email"],
    });
  });

  it("un-ticks a format that was ticked", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByLabelText(/Reel/));
    await user.click(screen.getByLabelText(/Reel/));
    expect(screen.getByRole("button", { name: /^Write/ })).toBeDisabled();
  });

  // The database refuses a seventh; stopping at six here means the operator
  // never meets that refusal. Asserted on the control's own state as well as
  // on the count — clicking a disabled input is a no-op, so a count-only
  // assertion passes even when the cap has been removed from the handler.
  it("stops at six, matching the limit the database enforces", async () => {
    const user = userEvent.setup();
    show();
    for (const label of [/Reel/, /Short/, /Story clips/, /Carousel/, /Quote graphic/, /Ad variation/]) {
      await user.click(screen.getByLabelText(label));
    }
    expect(screen.getByRole("button", { name: /^Write 6 briefs$/ })).toBeEnabled();

    // The seventh is refused at the control itself.
    expect(screen.getByLabelText(/Text post/)).toBeDisabled();
    expect(screen.getByLabelText(/Email/)).toBeDisabled();
    // …and an already-picked one stays available to un-tick.
    expect(screen.getByLabelText(/Reel/)).toBeEnabled();

    await user.click(screen.getByLabelText(/Text post/));
    expect(screen.getByRole("button", { name: /^Write 6 briefs$/ })).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  // Each derivative is a model call, so the cost is stated before the click.
  it("shows what it will cost before committing", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByLabelText(/Reel/));
    await user.click(screen.getByLabelText(/Carousel/));
    expect(screen.getByText(/2 of 6 · roughly \$0\.40/)).toBeInTheDocument();
  });
});

describe("RepurposeModal — outcomes", () => {
  it("reports a refusal from the database instead of closing", async () => {
    rpc.mockResolvedValue({
      error: { message: "Only an approved asset can be repurposed - this one is pending." },
    });
    const user = userEvent.setup();
    const { onClose, onQueued } = show();
    await user.click(screen.getByLabelText(/Reel/));
    await user.click(screen.getByRole("button", { name: /^Write/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("this one is pending");
    expect(onClose).not.toHaveBeenCalled();
    expect(onQueued).not.toHaveBeenCalled();
  });

  it("closes and reports success when it queues", async () => {
    const user = userEvent.setup();
    const { onClose, onQueued } = show();
    await user.click(screen.getByLabelText(/Reel/));
    await user.click(screen.getByRole("button", { name: /^Write/ }));

    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });
});
