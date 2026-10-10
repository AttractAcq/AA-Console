import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn(async () => ({ data: "project-1", error: null })) }));
vi.mock("../../lib/media", () => ({ signPaths: async () => new Map() }));
vi.mock("../../lib/supabase", () => ({ supabase: {
  rpc,
  from: () => { const chain = { select: () => chain, eq: () => chain,
    order: () => chain, limit: async () => ({ data: [], error: null }) }; return chain; },
} }));
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useParams: () => ({ clientId: "client-1" }),
}));

import { MotionDesignPanel } from "./MotionDesignPanel";

it("queues a hero motion video from its own client page", async () => {
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
