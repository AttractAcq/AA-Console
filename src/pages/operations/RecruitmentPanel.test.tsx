import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, download } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  download: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
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

  it("loads the editor template and creates a recruitment brief", async () => {
    const user = userEvent.setup();
    render(<RecruitmentPanel />);
    await user.click(await screen.findByRole("button", { name: "New recruitment ad" }));
    await user.click(screen.getByRole("button", { name: "Editor" }));
    expect(screen.getByDisplayValue("Editor — Attract Acquisition")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Cut the work that actually ships")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Apply URL/), "https://attractacq.com/careers/editor");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        "create_recruitment_brief",
        expect.objectContaining({
          p_role: "editor",
          p_title: "Editor — Attract Acquisition",
          p_apply_url: "https://attractacq.com/careers/editor",
        }),
      ),
    );
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
