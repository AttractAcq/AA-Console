import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The line this page holds.
 *
 * Brand QA and claim QA both passing means a candidate is waiting for a
 * person, not that it has shipped — so a clean candidate must read as waiting
 * and must offer Accept rather than appearing done. And a cut whose scene
 * cites proof that has lost its permission must be stopped and say so,
 * because the QA ran before the rights changed.
 */

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({ useParams: () => ({ clientId: "client-1" }) }));

import { MotionScenesPanel } from "./MotionScenesPanel";

const project = (over: Record<string, unknown> = {}) => ({
  id: "proj-1", client_id: "client-1", prompt: "Garage conversion explainer",
  preset: "explainer", aspect: "vertical", duration_sec: 16, brand_mode: "on_brand",
  revision_of: null, status: "completed",
  scene_plan: [{ beat: "Hook" }, { beat: "Problem" }],
  render_path: "motion/r1.mp4", poster_path: null, job_id: null, error: null,
  created_by: null, created_at: "2026-10-24T09:00:00Z", completed_at: null, ...over,
});

const scene = (over: Record<string, unknown> = {}) => ({
  id: "scene-1", project_id: "proj-1", client_id: "client-1", position: 1,
  beat: "Hook", script: "Your garage is wasted space", start_sec: 0, duration_sec: 2,
  proof_asset_id: null, locked: true,
  created_at: "2026-10-24T09:00:00Z", updated_at: "2026-10-24T09:00:00Z", ...over,
});

const candidate = (over: Record<string, unknown> = {}) => ({
  candidate_id: "cand-1", client_id: "client-1", project_id: "proj-1",
  prompt: "Garage conversion explainer", preset: "explainer", attempt: 1,
  render_path: "motion/r1.mp4", brand_qa: "pass", brand_qa_detail: null,
  claim_qa: "pass", claim_qa_detail: null, accepted_at: null, rejected_reason: null,
  benchmark_note: null, scenes: 4, scenes_citing_proof: 0, scenes_citing_lost_proof: 0,
  blocker: null, ...over,
});

function database(options: { projects?: unknown[]; scenes?: unknown[]; candidates?: unknown[] } = {}) {
  from.mockImplementation((table: string) => {
    const payload = () => {
      if (table === "motion_design_projects") return options.projects ?? [project()];
      if (table === "motion_scenes") return options.scenes ?? [];
      return options.candidates ?? [candidate()];
    };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async () => ({ data: payload(), error: null }),
      then: (...a: Parameters<Promise<unknown>["then"]>) =>
        Promise.resolve({ data: payload(), error: null }).then(...a),
    });
    return chain;
  });
  rpc.mockResolvedValue({ data: null, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  database();
});

describe("scenes", () => {
  it("offers seeding only while a project has none", async () => {
    database({ scenes: [] });
    render(<MotionScenesPanel tab="scenes" />);
    await userEvent.click(await screen.findByRole("button", { name: "Seed its scenes" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("seed_motion_scenes_v6", { p_project_id: "proj-1" }),
    );
  });

  it("does not offer it again once scenes exist, so an edit cannot be lost", async () => {
    database({ scenes: [scene()] });
    render(<MotionScenesPanel tab="scenes" />);
    expect(await screen.findByText("1 · Hook")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Seed its scenes" })).not.toBeInTheDocument();
  });

  it("shows which scenes are locked and which cite proof", async () => {
    database({
      scenes: [
        scene(),
        scene({ id: "scene-3", position: 3, beat: "Proof", locked: false, proof_asset_id: "proof-1", start_sec: 7, duration_sec: 6 }),
      ],
    });
    render(<MotionScenesPanel tab="scenes" />);
    expect(await screen.findByText(/0–2s · locked/)).toBeInTheDocument();
    expect(screen.getByText(/7–13s · editable/)).toBeInTheDocument();
    expect(screen.getByText("cites proof")).toBeInTheDocument();
  });
});

describe("candidates", () => {
  it("treats a clean candidate as waiting for a person, not as shipped", async () => {
    render(<MotionScenesPanel tab="renders" />);
    expect(await screen.findByText("QA passed — waiting for a person")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept this cut" })).toBeInTheDocument();
  });

  it("names which QA failed and offers no acceptance", async () => {
    database({
      candidates: [
        candidate({
          brand_qa: "fail", brand_qa_detail: "Off-palette in scene 3",
          blocker: "Brand QA failed: Off-palette in scene 3.",
        }),
      ],
    });
    render(<MotionScenesPanel tab="renders" />);
    expect(await screen.findByText("Brand QA failed: Off-palette in scene 3.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept this cut" })).not.toBeInTheDocument();
  });

  it("stops a cut whose scene cites proof that has gone, and counts them", async () => {
    database({
      candidates: [
        candidate({
          scenes_citing_proof: 1, scenes_citing_lost_proof: 1,
          blocker: "A scene cites proof that is no longer usable. The cut is wrong whatever the QA says.",
        }),
      ],
    });
    render(<MotionScenesPanel tab="renders" />);
    expect(await screen.findByText(/no longer usable/)).toBeInTheDocument();
    expect(screen.getByText(/1 scene cite proof that has gone/)).toBeInTheDocument();
  });

  it("says QA has not run rather than treating silence as a pass", async () => {
    database({
      candidates: [
        candidate({ brand_qa: null, claim_qa: null, blocker: "QA has not run on this candidate yet." }),
      ],
    });
    render(<MotionScenesPanel tab="renders" />);
    expect(await screen.findByText("QA has not run on this candidate yet.")).toBeInTheDocument();
    expect(screen.getAllByText("not run")).toHaveLength(2);
  });

  it("accepts a cut, and needs a reason to reject one", async () => {
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("  ");
    render(<MotionScenesPanel tab="renders" />);
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(rpc).not.toHaveBeenCalled();
    prompt.mockRestore();

    await userEvent.click(screen.getByRole("button", { name: "Accept this cut" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("accept_motion_candidate_v6", {
        p_candidate_id: "cand-1",
        p_accepted: true,
      }),
    );
  });

  it("says a candidate has not been benchmarked rather than implying it has", async () => {
    render(<MotionScenesPanel tab="renders" />);
    expect(await screen.findByText("not compared")).toBeInTheDocument();
  });
});
