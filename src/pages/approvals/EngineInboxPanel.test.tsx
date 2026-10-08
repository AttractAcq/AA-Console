import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, signPaths, useParams } = vi.hoisted(() => ({
  rpc: vi.fn(),
  signPaths: vi.fn(),
  useParams: vi.fn(),
}));

let inboxRows: unknown[] = [];
let rejectedRows: unknown[] = [];
let assetRows: unknown[] = [];
let inboxError: { message: string } | null = null;

vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useParams,
}));

vi.mock("../../lib/media", async () => {
  const actual = await vi.importActual<typeof import("../../lib/media")>("../../lib/media");
  return { ...actual, signPaths };
});

vi.mock("../../lib/supabase", () => {
  function table(name: string) {
    const result =
      name === "approval_inbox"
        ? { data: inboxRows, error: inboxError }
        : name === "content_slots"
          ? { data: rejectedRows, error: null }
          : { data: assetRows, error: null };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      in: () => Promise.resolve(result),
      order: () => Promise.resolve(result),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    });
    return chain;
  }
  return { supabase: { from: (name: string) => table(name), rpc: (...a: unknown[]) => rpc(...a) } };
});

import { EngineInboxPanel } from "./EngineInboxPanel";

const row = (over: Record<string, unknown> = {}) => ({
  slot_id: "slot-1",
  client_id: "client-1",
  client_name: "Harbour",
  platform: "instagram",
  format: "reel",
  scheduled_at: "2026-10-08T09:00:00Z",
  qa_score: 92,
  qa_findings: [],
  finding_count: 0,
  warnings: 0,
  attempts: 0,
  cost_usd: "1.2500",
  asset_id: "asset-1",
  asset_title: "The Chain",
  pillar_name: "Proof",
  idea_score: "7.5",
  idea_reasons: ["Nothing like it in the last month."],
  waiting_for: "03:14:00",
  goes_out_in: "20:00:00",
  overdue: false,
  human_approved_at: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  inboxRows = [row()];
  rejectedRows = [];
  assetRows = [
    { id: "asset-1", storage_path: "client-1/a.mp4", render_path: null, media_type: "video" },
  ];
  inboxError = null;
  useParams.mockReturnValue({ clientId: "client-1" });
  rpc.mockResolvedValue({ data: null, error: null });
  signPaths.mockResolvedValue(new Map([["client-1/a.mp4", "https://signed/a.mp4"]]));
});

describe("what is waiting on a person", () => {
  it("shows the slot with what QA found and when it goes out", async () => {
    render(<EngineInboxPanel />);
    expect(await screen.findByText("The Chain")).toBeInTheDocument();
    expect(screen.getByText(/Goes out in 20 hours/)).toBeInTheDocument();
    expect(screen.getByText(/Waiting 3 hours/)).toBeInTheDocument();
    expect(screen.getByText(/92\/100/)).toBeInTheDocument();
    expect(screen.getByText("Nothing like it in the last month.")).toBeInTheDocument();
  });

  it("says an empty queue means the engine has caught up or is not running", async () => {
    inboxRows = [];
    render(<EngineInboxPanel />);
    expect(await screen.findByText(/Nothing is waiting on a person/)).toBeInTheDocument();
  });

  it("shows a blocker as blocking, not as a warning", async () => {
    inboxRows = [
      row({
        qa_findings: [
          { severity: "blocker", area: "brand", detail: "Says the thing the brand forbids." },
          { severity: "warning", area: "claims", detail: "No proof on file." },
        ],
      }),
    ];
    render(<EngineInboxPanel />);
    expect(await screen.findByText("Blocking")).toBeInTheDocument();
    expect(screen.getByText(/brand — Says the thing the brand forbids\./)).toBeInTheDocument();
    expect(screen.getByText("Worth a look")).toBeInTheDocument();
  });

  it("puts what is already late at the top", async () => {
    inboxRows = [
      row({ slot_id: "later", asset_title: "Later", scheduled_at: "2026-10-20T09:00:00Z", goes_out_in: "13 days" }),
      row({ slot_id: "late", asset_title: "Late", scheduled_at: "2026-10-01T09:00:00Z", overdue: true, goes_out_in: "-5 days" }),
    ];
    render(<EngineInboxPanel />);
    await screen.findByText("Late");
    const titles = screen.getAllByText(/^(Late|Later)$/).map((n) => n.textContent);
    expect(titles).toEqual(["Late", "Later"]);
  });

  it("plays the reel a person is being asked to approve", async () => {
    // A reel reviewed from a filename is a reel nobody watched, and this
    // card is the one place the decision is made.
    render(<EngineInboxPanel />);
    await screen.findByText("The Chain");
    const player = document.querySelector("video");
    expect(player).not.toBeNull();
    expect(player!.getAttribute("src")).toBe("https://signed/a.mp4");
    // Not autoplay: a queue of reels all talking at once is worse than a
    // queue of still frames.
    expect(player!.hasAttribute("autoplay")).toBe(false);
  });

  it("shows an image inline rather than a player", async () => {
    assetRows = [
      { id: "asset-1", storage_path: "client-1/a.png", render_path: null, media_type: "image" },
    ];
    signPaths.mockResolvedValue(new Map([["client-1/a.png", "https://signed/a.png"]]));
    render(<EngineInboxPanel />);
    const shot = await screen.findByRole("img", { name: /the chain/i });
    expect(shot).toHaveAttribute("src", "https://signed/a.png");
    expect(document.querySelector("video")).toBeNull();
  });

  it("falls back to a link for anything it cannot show", async () => {
    assetRows = [
      { id: "asset-1", storage_path: "client-1/a.md", render_path: null, media_type: "text" },
    ];
    signPaths.mockResolvedValue(new Map([["client-1/a.md", "https://signed/a.md"]]));
    render(<EngineInboxPanel />);
    const link = await screen.findByRole("link", { name: /open the asset/i });
    expect(link).toHaveAttribute("href", "https://signed/a.md");
  });

  it("prefers the cut over the opening still", async () => {
    // For a reel the cut is the thing being approved; storage_path is the
    // first frame.
    assetRows = [
      {
        id: "asset-1",
        storage_path: "client-1/still.png",
        render_path: "client-1/cut.mp4",
        media_type: "video",
      },
    ];
    signPaths.mockResolvedValue(new Map([["client-1/cut.mp4", "https://signed/cut.mp4"]]));
    render(<EngineInboxPanel />);
    await screen.findByText("The Chain");
    expect(document.querySelector("video")!.getAttribute("src")).toBe("https://signed/cut.mp4");
  });
});

describe("approving", () => {
  it("calls approve_slot, which is the only thing that also schedules the post", async () => {
    // review_media_asset would sign the asset off and move nothing.
    render(<EngineInboxPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /approve and schedule/i }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("approve_slot", { p_slot_id: "slot-1" }));
  });

  it("shows what the database said when it refused", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "That slot is qa, not waiting for approval." } });
    render(<EngineInboxPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /approve and schedule/i }));
    expect(await screen.findByText(/not waiting for approval/)).toBeInTheDocument();
  });
});

describe("rejecting", () => {
  it("will not send a rejection with no reason", async () => {
    // reject_slot refuses one, and the reason is what the engine writes the
    // next attempt from.
    render(<EngineInboxPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Reject" });
    expect(confirm).toBeDisabled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sends the reason with it", async () => {
    render(<EngineInboxPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox"), "The hook is the wrong claim.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("reject_slot", {
        p_slot_id: "slot-1",
        p_reason: "The hook is the wrong claim.",
      }),
    );
  });
});

describe("making a rejected slot again", () => {
  it("is a separate act, on the rejected list", async () => {
    inboxRows = [];
    rejectedRows = [
      {
        id: "slot-9",
        platform: "instagram",
        format: "single",
        scheduled_at: "2026-10-09T09:00:00Z",
        blocked_reason: "The hook is the wrong claim.",
        attempts: 1,
        idea_id: "idea-1",
      },
    ];
    render(<EngineInboxPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /make it again/i }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("regenerate_slot", { p_slot_id: "slot-9" }));
  });

  it("does not offer it when there is no idea to write a new brief from", async () => {
    inboxRows = [];
    rejectedRows = [
      {
        id: "slot-9",
        platform: "instagram",
        format: "single",
        scheduled_at: "2026-10-09T09:00:00Z",
        blocked_reason: "No good.",
        attempts: 1,
        idea_id: null,
      },
    ];
    render(<EngineInboxPanel />);
    expect(await screen.findByText(/No idea on it to write a new brief from/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /make it again/i })).not.toBeInTheDocument();
  });
});

describe("when the queue cannot be read", () => {
  it("says so and offers to try again", async () => {
    inboxError = { message: "permission denied for view approval_inbox" };
    render(<EngineInboxPanel />);
    expect(await screen.findByText(/permission denied/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
