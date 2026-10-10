import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

const { rpc, scenario } = vi.hoisted(() => ({
  rpc: vi.fn(async () => ({ data: "project-1", error: null })),
  scenario: { projects: [] as Record<string, unknown>[], briefs: [] as Record<string, unknown>[] },
}));
vi.mock("../../lib/media", () => ({ signPaths: async () => new Map() }));
vi.mock("../../lib/supabase", () => ({ supabase: {
  rpc,
  from: (table: string) => { const chain = { select: () => chain, eq: () => chain,
    order: () => chain, limit: async () => ({ data: table === "motion_design_projects"
      ? scenario.projects : table === "client_briefs" ? scenario.briefs : [], error: null }),
    in: async () => ({ data: [], error: null }) }; return chain; },
} }));
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useParams: () => ({ clientId: "client-1" }),
}));

import { MotionDesignPanel } from "./MotionDesignPanel";

it("queues a hero motion video from its own client page", async () => {
  scenario.projects = []; scenario.briefs = []; rpc.mockClear();
  render(<MemoryRouter><MotionDesignPanel /></MemoryRouter>);
  await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }),
    "A calm animated hero introducing our client growth process.");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Motion use" }), "hero");
  await userEvent.click(screen.getByRole("button", { name: "Generate video" }));
  expect(rpc).toHaveBeenCalledWith("request_motion_design", {
    p_client_id: "client-1", p_prompt: "A calm animated hero introducing our client growth process.",
    p_preset: "hero", p_aspect: "horizontal", p_duration_sec: 8,
    p_brand_mode: "on_brand", p_revision_of: null,
  });
});

it("sends a completed motion project to the normal approval gate", async () => {
  scenario.projects = [{ id: "motion-1", prompt: "A short motion explainer for our service.",
    preset: "explainer", aspect: "horizontal", duration_sec: 8, brand_mode: "on_brand",
    status: "completed", scene_plan: { scenes: [] }, render_path: "client-1/motion.mp4",
    poster_path: null, error: null, revision_of: null, created_at: "2026-10-10" }];
  scenario.briefs = [{ id: "brief-1", title: "Approved explainer brief" }];
  rpc.mockClear();
  render(<MemoryRouter><MotionDesignPanel /></MemoryRouter>);
  await userEvent.selectOptions(await screen.findByRole("combobox", {
    name: "Attach explainer motion design" }), "brief-1");
  await userEvent.click(screen.getByRole("button", { name: "Send to approvals" }));
  expect(rpc).toHaveBeenCalledWith("attach_motion_design", {
    p_project_id: "motion-1", p_brief_id: "brief-1",
  });
});
