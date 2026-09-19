import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, download, callRuntime } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  download: vi.fn(),
  callRuntime: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("../../lib/callRuntime", () => ({ callRuntime }));
vi.mock("../../lib/useAgentJobs", () => ({ useAgentJobs: () => ({ inFlight: [], recentFailures: [] }) }));
vi.mock("../../lib/media", async (original) => {
  const actual = await original<typeof import("../../lib/media")>();
  return { ...actual, signPaths: async () => new Map([["house/ad.png", "https://signed/ad.png"]]) };
});
vi.mock("../../lib/recruitment", async (original) => {
  const actual = await original<typeof import("../../lib/recruitment")>();
  return { ...actual, downloadRecruitmentCopyPack: download };
});

import { RecruitmentPanel } from "./RecruitmentPanel";

const HOUSE = "house-1";
const draft = {
  id: "brief-1",
  title: "Editor — Attract Acquisition",
  status: "draft",
  recruitment_role: "editor",
  apply_url: "https://attractacq.com/careers/editor",
  compensation_text: "£250/day",
  hook: "Cut the work that actually ships",
  script: "Attract Acquisition is hiring an editor.",
  call_to_action: "Apply now",
  created_at: "2026-09-17T08:00:00Z",
};
const pendingAsset = {
  id: "asset-1",
  client_id: HOUSE,
  brief_id: "brief-1",
  ref_number: "AA-0042",
  media_type: "image",
  title: "Editor ad",
  storage_path: "house/ad.png",
  review_status: "pending",
  member_id: null,
  created_at: "2026-09-17T09:00:00Z",
};

let briefs: unknown[] = [];
let pending: unknown[] = [];
let approved: unknown[] = [];

function tableChain(data: unknown, single: unknown = null) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order"]) chain[method] = () => chain;
  chain.maybeSingle = () => Promise.resolve({ data: single, error: null });
  chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(resolve, reject);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  briefs = [];
  pending = [];
  approved = [];
  rpc.mockImplementation((name: string) => {
    if (name === "aa_house_client_id") return Promise.resolve({ data: HOUSE, error: null });
    return Promise.resolve({ data: { generation_id: "gen-1", render_id: "render-1", job_id: "job-1" }, error: null });
  });
  from.mockImplementation((table: string) => {
    if (table === "client_briefs") return tableChain(briefs);
    if (table === "client_brand_profiles") return tableChain(null, { colour_primary: "#111111", imagery_style: "Documentary" });
    if (table === "creative_generations") {
      return tableChain([
        {
          brief_id: "brief-1",
          concept: { headline: "Cut the work that actually ships", subhead: "On-brand stills", call_to_action: "Apply now" },
          created_at: "2026-09-17T09:05:00Z",
        },
      ]);
    }
    // pending vs approved distinguished by the last eq(review_status)
    const captured: string[] = [];
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "in", "order"]) chain[method] = () => chain;
    chain.eq = (...args: unknown[]) => {
      captured.push(String(args[1] ?? args[0]));
      return chain;
    };
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve({
        data: captured.includes("approved") ? approved : pending,
        error: null,
      }).then(resolve, reject);
    return chain;
  });
});

describe("RecruitmentPanel — role pick and brief", () => {
  it("offers only editor, smm and avatar", async () => {
    render(<RecruitmentPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "New recruitment ad" }));
    expect(screen.getByRole("button", { name: "Editor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Social Media Manager" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Avatar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /producer/i })).not.toBeInTheDocument();
  });

  it("opens a blank form and creates a brief from what was typed", async () => {
    // The form used to arrive pre-filled with one of three canned briefs. It
    // now starts empty, so typing your own ad is the ordinary path.
    const user = userEvent.setup();
    render(<RecruitmentPanel />);
    await user.click(await screen.findByRole("button", { name: "New recruitment ad" }));
    await user.click(screen.getByRole("button", { name: "Editor" }));

    expect(screen.queryByDisplayValue("Editor — Attract Acquisition")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Cut the work that actually ships")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Title/), "Editor — vertical cutdowns");
    await user.type(screen.getByLabelText(/^Headline/), "Cut the work that ships");
    await user.type(screen.getByLabelText(/Primary text/), "You take an approved brief and finish it.");
    await user.type(screen.getByLabelText(/Call to action/), "Apply now");
    await user.type(screen.getByLabelText(/Apply URL/), "https://attractacq.com/careers/editor");
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        "create_recruitment_brief",
        expect.objectContaining({
          p_role: "editor",
          p_title: "Editor — vertical cutdowns",
          p_apply_url: "https://attractacq.com/careers/editor",
        }),
      ),
    );
  });
});

describe("RecruitmentPanel — writing the ad with AI", () => {
  const GENERATED = {
    title: "Editor — vertical cutdowns for dental practices",
    hook: "Cut the work that actually ships",
    script: "You take an approved brief and turn it into a still that looks like the practice.",
    call_to_action: "Apply now",
    visual_direction: "A quiet editing desk, documentary light, a real timeline on screen.",
    premise: "We hire editors who finish assets.",
  };

  async function openGenerator() {
    const user = userEvent.setup();
    render(<RecruitmentPanel />);
    await user.click(await screen.findByRole("button", { name: "New recruitment ad" }));
    await user.click(screen.getByRole("button", { name: "Editor" }));
    await user.click(screen.getByRole("button", { name: "Generate with AI" }));
    return user;
  }

  it("sends the role and the operator's notes, and fills the form", async () => {
    callRuntime.mockResolvedValue({ draft: GENERATED });
    const user = await openGenerator();

    await user.type(screen.getByLabelText(/About this role/), "Must cut vertical. Durban hours.");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() =>
      expect(callRuntime).toHaveBeenCalledWith("/admin/recruitment/draft", {
        role: "editor",
        notes: "Must cut vertical. Durban hours.",
      }),
    );
    expect(await screen.findByDisplayValue(GENERATED.title)).toBeInTheDocument();
    expect(screen.getByDisplayValue(GENERATED.hook)).toBeInTheDocument();
    expect(screen.getByDisplayValue(GENERATED.script)).toBeInTheDocument();
  });

  it("leaves the apply URL and compensation empty for a person to fill in", async () => {
    // A generated apply link sends a real applicant somewhere invented, and a
    // generated rate is money AA did not agree to pay.
    callRuntime.mockResolvedValue({
      draft: { ...GENERATED, apply_url: "https://invented.example/apply", compensation_text: "R900/day" },
    });
    const user = await openGenerator();
    await user.type(screen.getByLabelText(/About this role/), "Durban hours.");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    await screen.findByDisplayValue(GENERATED.title);
    expect(screen.getByLabelText(/Apply URL/)).toHaveValue("");
    expect(screen.getByLabelText(/Compensation/)).toHaveValue("");
    expect(screen.queryByDisplayValue("R900/day")).not.toBeInTheDocument();
  });

  it("will not generate from an empty box", async () => {
    const user = await openGenerator();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    await user.type(screen.getByLabelText(/About this role/), "x");
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
  });

  it("shows the runtime's refusal and keeps the dialog open to try again", async () => {
    callRuntime.mockRejectedValue(new Error("The primary text is too thin to be an ad."));
    const user = await openGenerator();
    await user.type(screen.getByLabelText(/About this role/), "Durban hours.");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/too thin to be an ad/);
    expect(screen.getByLabelText(/About this role/)).toBeInTheDocument();
  });
});

describe("RecruitmentPanel — deleting an ad", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("deletes the ad and its generated images together", async () => {
    // client_media_assets.brief_id is ON DELETE SET NULL, so deleting only the
    // brief would leave its image in Asset review with nothing to say what it
    // was for. One RPC removes both.
    briefs = [draft];
    rpc.mockImplementation((name: string) => {
      if (name === "aa_house_client_id") return Promise.resolve({ data: HOUSE, error: null });
      return Promise.resolve({ data: [{ deleted_assets: 1 }], error: null });
    });
    render(<RecruitmentPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Delete Editor/i }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("delete_recruitment_ad", { p_brief_id: "brief-1" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/1 generated image/i);
  });

  it("asks first, and does nothing if the answer is no", async () => {
    briefs = [draft];
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<RecruitmentPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Delete Editor/i }));
    await waitFor(() => expect(rpc).not.toHaveBeenCalledWith("delete_recruitment_ad", expect.anything()));
  });

  it("shows the database's refusal rather than pretending it worked", async () => {
    briefs = [draft];
    // Selective: a blanket mock would also break the house-client lookup the
    // panel does on load, and the test would pass for the wrong reason.
    rpc.mockImplementation((name: string) => {
      if (name === "aa_house_client_id") return Promise.resolve({ data: HOUSE, error: null });
      return Promise.resolve({ data: null, error: { message: "That is not a recruitment ad." } });
    });
    render(<RecruitmentPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Delete Editor/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not a recruitment ad/i);
    // A refusal that also announces success is worse than a silent one: the
    // ad is still there and the screen says it is gone.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("RecruitmentPanel — approve, generate, review, export", () => {
  it("approves a draft through the admin-only RPC", async () => {
    briefs = [draft];
    render(<RecruitmentPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve brief" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("approve_recruitment_brief", { p_brief_id: "brief-1" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/approved/i);
  });

  it("generates via generate_recruitment_ad, not a custom MCP tool", async () => {
    briefs = [{ ...draft, status: "approved" }];
    render(<RecruitmentPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Generate Meta static" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("generate_recruitment_ad", {
        p_brief_id: "brief-1",
        p_quality: "medium",
        p_size: "1024x1536",
      }),
    );
    expect(rpc.mock.calls.some((c) => String(c[0]).startsWith("recruitment."))).toBe(false);
  });

  it("reviews a pending asset with the existing review RPC", async () => {
    briefs = [{ ...draft, status: "complete" }];
    pending = [pendingAsset];
    render(<RecruitmentPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("review_media_asset", {
        p_asset_id: "asset-1",
        p_decision: "approved",
        p_reason: undefined,
      }),
    );
  });

  it("downloads a copy pack in the locked Meta-static shape", async () => {
    briefs = [{ ...draft, status: "complete" }];
    approved = [{ ...pendingAsset, review_status: "approved" }];
    render(<RecruitmentPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Download copy pack" }));
    await waitFor(() => expect(download).toHaveBeenCalled());
    expect(download.mock.calls[0][0]).toMatchObject({
      purpose: "recruitment",
      role: "editor",
      format: "meta_static",
      headline: "Cut the work that actually ships",
      primary_text: "On-brand stills",
      cta: "Apply now",
      apply_url: "https://attractacq.com/careers/editor",
      compensation: "£250/day",
      image: { asset_id: "asset-1", ref_number: "AA-0042", storage_path: "house/ad.png" },
    });
  });
});
