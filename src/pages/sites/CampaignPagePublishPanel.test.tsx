import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one distinction this board exists to protect.
 *
 * A page whose form posts nowhere has the same commit, the same URL and the
 * same screenshot as one that works. So "published but untested" must never
 * read as live, and a failed probe must say what failed rather than leaving
 * a green row with a footnote.
 */

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-1" }),
  Link: ({ to, children }: { to: string; children: unknown }) =>
    createElement("a", { href: to }, children as never),
}));

import { CampaignPagePublishPanel } from "./CampaignPagePublishPanel";

const row = (over: Record<string, unknown> = {}) => ({
  approval_id: "app-1", client_id: "client-1", campaign_id: "camp-1", page_id: "page-1",
  site_path: "p/garage-survey/", rendered_sha256: "7b31c9f0".repeat(8),
  publication_id: "pub-1", published_url: "https://harbourhome.co.uk/garage-survey",
  commit_sha: "a41f9cdef", probe_status: "passed", probe_detail: null,
  blocker: "Live and tested.", ...over,
});

const publication = (over: Record<string, unknown> = {}) => ({
  id: "pub-1", approval_id: "app-1", client_id: "client-1", page_id: "page-1",
  revision_id: "rev-1", published_url: "https://harbourhome.co.uk/garage-survey",
  commit_sha: "a41f9cdef", rendered_sha256: "7b31c9f0".repeat(8),
  probe_status: "passed", probe_detail: null, probe_lead_id: "lead-1",
  probed_at: "2026-10-24T10:00:00Z", published_at: "2026-10-24T09:55:00Z", ...over,
});

function database(due: unknown[], publications: unknown[] = []) {
  from.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: async () => ({ data: table === "campaign_page_publish_due" ? due : publications, error: null }),
      order: async () => ({ data: publications, error: null }),
    });
    if (table === "campaign_page_publications") {
      Object.assign(chain, { eq: () => chain });
    }
    return chain;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("published is not the same as working", () => {
  it("counts only a tested page as live", async () => {
    database([row(), row({ approval_id: "app-2", probe_status: null, probe_detail: null, blocker: "Published. Nobody has tested the form yet." })]);
    render(<CampaignPagePublishPanel />);

    expect(await screen.findByText(/1 live and tested/)).toBeInTheDocument();
    expect(screen.getByText(/1 published but untested/)).toBeInTheDocument();
  });

  it("says a published page is untested rather than showing it as live", async () => {
    database([
      row({ probe_status: null, blocker: "Published. Nobody has tested the form yet." }),
    ]);
    render(<CampaignPagePublishPanel />);
    expect(
      await screen.findByText("Published. Nobody has tested the form yet."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Live and tested.")).not.toBeInTheDocument();
  });

  it("shows what the probe found when it failed", async () => {
    database([
      row({
        probe_status: "failed",
        probe_detail: "A lead arrived but without consent.",
        blocker: "Published, but the form probe failed: A lead arrived but without consent.",
      }),
    ]);
    render(<CampaignPagePublishPanel />);
    expect(await screen.findByText(/the form probe failed/)).toBeInTheDocument();
    expect(screen.getByText("A lead arrived but without consent.")).toBeInTheDocument();
  });

  it("shows the blocker the database gave for a page that cannot publish", async () => {
    database([
      row({
        publication_id: null, published_url: null, commit_sha: null, probe_status: null,
        blocker: "The page changed after it was approved. Request approval of the new version.",
      }),
    ]);
    render(<CampaignPagePublishPanel />);
    expect(
      await screen.findByText(
        "The page changed after it was approved. Request approval of the new version.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("not published")).toBeInTheDocument();
  });

  it("says plainly when nothing has been approved", async () => {
    database([]);
    render(<CampaignPagePublishPanel />);
    expect(
      await screen.findByText(/nothing has been approved for publication yet/),
    ).toBeInTheDocument();
  });
});

describe("the commit trail", () => {
  it("lists every commit with what its probe found", async () => {
    database([row()], [publication(), publication({ id: "pub-0", commit_sha: "99aa88b", probe_status: "failed", probe_detail: "No lead appeared." })]);
    render(<CampaignPagePublishPanel />);
    expect(await screen.findByText("Every commit, in order")).toBeInTheDocument();
    expect(screen.getByText("99aa88b")).toBeInTheDocument();
    expect(screen.getByText("No lead appeared.")).toBeInTheDocument();
  });
});
