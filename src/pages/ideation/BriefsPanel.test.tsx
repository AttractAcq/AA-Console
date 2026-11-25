import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { briefStatus, update, eq, resultRow } = vi.hoisted(() => ({
  briefStatus: { value: "in_production", media: "text" }, update: vi.fn(), eq: vi.fn(),
  resultRow: { found: true },
}));

vi.mock("../../lib/useAgentJobs", () => ({ useAgentJobs: () => ({ inFlight: [], recentFailures: [] }) }));
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const data = table === "client_briefs" ? [{
        id: "brief-1", title: "Founder video", body: "Record the founder", media_type: "video",
        content_format: "single", target_platform: "instagram", brief_ref: "BR-1",
        ...(briefStatus.value === "draft" ? {
          media_type: briefStatus.media, argument: "Old argument", script: "Old script", updated_at: "revision-1",
          body: "## Argument\n\nOld argument\n\n## Script\n\nOld script", purpose: "client", archived_at: null,
          ...(briefStatus.media === "image" ? {
            visual_direction: "Old art direction",
            body: "## Visual direction\n\nOld art direction\n\n## Argument\n\nOld argument\n\n## Script\n\nOld script",
          } : {}),
        } : {}),
        status: briefStatus.value, source_idea_id: "idea-1", created_at: "2026-10-10",
      }] : table === "job_assignments" ? [{
        id: "assignment-1", brief_id: "brief-1", stage: "delivered", asset_id: "asset-1",
        team_members: { name: "Taylor" },
      }] : [{ assignment_id: "assignment-1", email_status: "skipped" }];
      const result = { data, error: null };
      const chain = {
        update: (payload: unknown) => { update(payload); return chain; },
        maybeSingle: () => Promise.resolve({ data: resultRow.found ? { id: "brief-1" } : null, error: null }),
        select: () => chain, eq: (...args: unknown[]) => { eq(...args); return chain; }, neq: () => chain, is: () => chain,
        order: () => chain, limit: () => chain, in: () => Promise.resolve(result),
        then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
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
  beforeEach(() => { briefStatus.value = "in_production"; });
  it("shows the delivered assignment and missing email without hiding the work", async () => {
    render(<MemoryRouter initialEntries={["/?tab=briefs&brief=brief-1"]}><BriefsPanel /></MemoryRouter>);
    expect(await screen.findByText(/Taylor: delivered/)).toBeInTheDocument();
    expect(screen.getByText(/assigned, email not sent/)).toBeInTheDocument();
    // The row's actions moved behind one menu, named after the brief.
    fireEvent.click(screen.getByRole("button", { name: /^Actions for / }));
    expect(await screen.findByRole("menuitem", { name: "View delivery" })).toBeInTheDocument();
  });
  it("shows an archived production brief on Create", async () => {
    render(<MemoryRouter initialEntries={["/?brief=brief-1"]}><BriefsPanel stage="create" /></MemoryRouter>);
    expect(await screen.findByText(/Taylor: delivered/)).toBeInTheDocument();
    expect(screen.getByLabelText("Content production stages")).toHaveTextContent("Create");
  });
  it("offers an approved video brief as a sourced code-video entry", async () => {
    briefStatus.value = "approved";
    render(<MemoryRouter><BriefsPanel /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Video" }));
    expect(await screen.findByText("Founder video")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Actions for / }));
    expect(screen.getByRole("menuitem", { name: "Start code video from brief" }))
      .toBeInTheDocument();
  });
});

describe("reviewing the source brief before building", () => {
  it.each([true, false])("saves both fields and the worker body only on the same draft revision (found=%s)", async found => {
    briefStatus.value = "draft";
    briefStatus.media = "text";
    resultRow.found = found;
    update.mockClear();
    eq.mockClear();
    render(<MemoryRouter initialEntries={["/?tab=briefs&brief=brief-1"]}><BriefsPanel /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit draft copy" }));
    fireEvent.change(screen.getByDisplayValue("Old argument"), { target: { value: "New argument" } });
    fireEvent.change(screen.getByDisplayValue("Old script"), { target: { value: "New script" } });
    fireEvent.click(screen.getByRole("button", { name: "Save brief" }));
    expect(await screen.findByText(found ? "Brief saved." : /Refresh before saving/)).toBeInTheDocument();
    expect(update).toHaveBeenCalledExactlyOnceWith({
      argument: "New argument", script: "New script", body: "## Argument\n\nNew argument\n\n## Script\n\nNew script",
    });
    for (const filter of [["id", "brief-1"], ["client_id", "client-1"], ["updated_at", "revision-1"], ["status", "draft"]]) {
      expect(eq).toHaveBeenCalledWith(...filter);
    }
  });
  it("saves art direction with both copy fields on the reviewed single image", async () => {
    briefStatus.value = "draft";
    briefStatus.media = "image";
    resultRow.found = true;
    update.mockClear();
    render(<MemoryRouter initialEntries={["/?brief=brief-1"]}><BriefsPanel /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit draft copy" }));
    fireEvent.change(screen.getByDisplayValue("Old art direction"), { target: { value: "Use the original PNG." } });
    fireEvent.click(screen.getByRole("button", { name: "Save brief" }));
    expect(await screen.findByText("Brief saved.")).toBeInTheDocument();
    expect(update).toHaveBeenCalledExactlyOnceWith({
      script: "Old script", argument: "Old argument", visual_direction: "Use the original PNG.",
      body: "## Visual direction\n\nUse the original PNG.\n\n## Argument\n\nOld argument\n\n## Script\n\nOld script",
    });
    expect(eq).toHaveBeenCalledWith("media_type", "image");
  });
});
