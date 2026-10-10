import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/useAgentJobs", () => ({ useAgentJobs: () => ({ inFlight: [], recentFailures: [] }) }));
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const data = table === "client_briefs" ? [{
        id: "brief-1", title: "Founder video", body: "Record the founder", media_type: "video",
        content_format: "single", target_platform: "instagram", brief_ref: "BR-1",
        status: "in_production", source_idea_id: "idea-1", created_at: "2026-10-10",
      }] : table === "job_assignments" ? [{
        id: "assignment-1", brief_id: "brief-1", stage: "delivered", asset_id: "asset-1",
        team_members: { name: "Taylor" },
      }] : [{ assignment_id: "assignment-1", email_status: "skipped" }];
      const result = { data, error: null };
      const chain = {
        select: () => chain, eq: () => chain, neq: () => chain, is: () => chain,
        order: () => Promise.resolve(result), in: () => Promise.resolve(result),
      };
      return chain;
    },
  },
}));
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useParams: () => ({ clientId: "client-1" }),
}));

import { BriefsPanel } from "./BriefsPanel";

describe("BriefsPanel human Create handoff", () => {
  it("shows the delivered assignment and missing email without hiding the work", async () => {
    render(<MemoryRouter initialEntries={["/?tab=briefs&brief=brief-1"]}><BriefsPanel /></MemoryRouter>);
    expect(await screen.findByText(/Taylor: delivered/)).toBeInTheDocument();
    expect(screen.getByText(/assigned, email not sent/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View delivery" })).toBeInTheDocument();
  });
});
