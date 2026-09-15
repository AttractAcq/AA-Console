import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { from, rpc, useParams, useAgentJobs, inserts, deletes, rows } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  useParams: vi.fn(),
  useAgentJobs: vi.fn(),
  inserts: [] as Array<{ table: string; value: unknown }>,
  deletes: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
  rows: {
    pages: [] as Array<{ id: string; title: string; status: string; html: string | null; published_url: string | null }>,
    links: [] as Array<{ id: string; page_id: string; campaign_id: string }>,
  },
}));

vi.mock("../../lib/supabase", () => ({
  supabase: { from, rpc },
}));
vi.mock("react-router-dom", () => ({ useParams }));
vi.mock("../../lib/useAgentJobs", () => ({ useAgentJobs }));
vi.mock("../../components/pages/PagePreview", () => ({ PagePreview: () => null }));

import { PageBuilderPanel } from "./PageBuilderPanel";

const campaign = { id: "campaign-1", name: "Christmas Sale", status: "planning" };

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
  deletes.length = 0;
  rows.pages = [];
  rows.links = [];
  useParams.mockReturnValue({ clientId: "client-1" });
  useAgentJobs.mockReturnValue({ inFlight: [], recentFailures: [] });
  rpc.mockResolvedValue({ error: null });
  from.mockImplementation((table: string) => {
    let deleting = false;
    const filters: Array<[string, unknown]> = [];
    const chain = {
      select: () => chain,
      eq: (field: string, value: unknown) => { filters.push([field, value]); return chain; },
      in: (field: string, value: unknown) => { filters.push([field, value]); return chain; },
      order: () => chain,
      single: () => Promise.resolve({ data: { id: "page-1" }, error: null }),
      delete: () => { deleting = true; deletes.push({ table, filters }); return chain; },
      insert: (value: unknown) => {
        inserts.push({ table, value });
        if (table === "campaign_artifacts") {
          const link = value as { page_id: string; campaign_id: string };
          rows.links.push({ id: "link-1", page_id: link.page_id, campaign_id: link.campaign_id });
          return Promise.resolve({ error: null });
        }
        return chain;
      },
      then: (resolve: (value: unknown) => unknown) => {
        const deletedLinks = deleting && table === "campaign_artifacts" ? [...rows.links] : [];
        if (deletedLinks.length) rows.links = [];
        return Promise.resolve({
          error: null,
          data: deleting
            ? table === "client_pages" ? [{ id: "page-1" }] : deletedLinks.map((link) => ({ id: link.id }))
            : table === "client_campaigns" ? [campaign]
              : table === "client_pages" ? rows.pages : rows.links,
        }).then(resolve);
      },
    };
    return chain;
  });
});

it("links an already-built page to a campaign and can clear that link", async () => {
  rows.pages = [{ id: "page-1", title: "Existing page", status: "approved", html: "<html>Ready</html>", published_url: null }];
  render(<PageBuilderPanel />);
  const selector = await screen.findByLabelText("Campaign for Existing page");
  await screen.findByRole("option", { name: "Christmas Sale · planning" });
  fireEvent.change(selector, { target: { value: "campaign-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Save campaign" }));
  await waitFor(() => expect(inserts).toEqual(expect.arrayContaining([
    expect.objectContaining({ table: "campaign_artifacts", value: expect.objectContaining({ page_id: "page-1", campaign_id: "campaign-1", client_id: "client-1" }) }),
  ])));

  await screen.findByRole("status");
  fireEvent.change(selector, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save campaign" }));
  await waitFor(() => expect(deletes).toEqual(expect.arrayContaining([
    expect.objectContaining({ table: "campaign_artifacts", filters: expect.arrayContaining([["client_id", "client-1"], ["page_id", "page-1"], ["id", ["link-1"]]]) }),
  ])));
});

it("confirms and deletes only the selected client's page", async () => {
  rows.pages = [{ id: "page-1", title: "Old page", status: "approved", html: "<html>Ready</html>", published_url: null }];
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<PageBuilderPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete page" }));
  await waitFor(() => expect(deletes).toEqual(expect.arrayContaining([
    expect.objectContaining({ table: "client_pages", filters: expect.arrayContaining([["id", "page-1"], ["client_id", "client-1"], ["page_type", "landing"]]) }),
  ])));
  expect(confirm).toHaveBeenCalled();
  confirm.mockRestore();
});

it("uploads a built HTML page and links it to the selected campaign without queueing the agent", async () => {
  render(<PageBuilderPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Build Page" }));
  fireEvent.change(await screen.findByLabelText(/Page title/), { target: { value: "Christmas Sale landing" } });
  await screen.findByText("Christmas Sale · planning");
  fireEvent.change(screen.getByLabelText(/Campaign/), { target: { value: "campaign-1" } });
  fireEvent.change(screen.getByLabelText(/Built HTML file/), {
    target: { files: [new File(["<!doctype html><html><body>Ready</body></html>"], "landing.html", { type: "text/html" })] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save page" }));

  await waitFor(() => expect(inserts).toEqual(expect.arrayContaining([
    expect.objectContaining({
      table: "client_pages",
      value: expect.objectContaining({
        client_id: "client-1",
        title: "Christmas Sale landing",
        html: "<!doctype html><html><body>Ready</body></html>",
        built_at: expect.any(String),
      }),
    }),
    expect.objectContaining({
      table: "campaign_artifacts",
      value: {
        campaign_id: "campaign-1",
        client_id: "client-1",
        kind: "landing_page",
        page_id: "page-1",
      },
    }),
  ])));
  expect(rpc).not.toHaveBeenCalledWith("enqueue_agent_job", expect.anything());
});

it("queues the page agent when no HTML file is uploaded and still links the campaign", async () => {
  render(<PageBuilderPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Build Page" }));
  fireEvent.change(await screen.findByLabelText(/Page title/), { target: { value: "Agent-built page" } });
  await screen.findByText("Christmas Sale · planning");
  fireEvent.change(screen.getByLabelText(/Campaign/), { target: { value: "campaign-1" } });
  fireEvent.change(screen.getByLabelText(/What this page is for/), { target: { value: "Write the festive campaign page." } });
  fireEvent.click(screen.getByRole("button", { name: "Save page" }));

  await waitFor(() => expect(rpc).toHaveBeenCalledWith("enqueue_agent_job", {
    p_agent_key: "landing_page",
    p_client_id: "client-1",
    p_input_table: "client_pages",
    p_input_id: "page-1",
  }));
  expect(inserts).toEqual(expect.arrayContaining([
    expect.objectContaining({
      table: "campaign_artifacts",
      value: expect.objectContaining({ campaign_id: "campaign-1", page_id: "page-1" }),
    }),
  ]));
});

it("requires a brief when there is no uploaded HTML", async () => {
  render(<PageBuilderPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Build Page" }));
  fireEvent.change(await screen.findByLabelText(/Page title/), { target: { value: "No brief" } });
  fireEvent.click(screen.getByRole("button", { name: "Save page" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("required unless you upload a built HTML file");
  expect(inserts).toEqual([]);
});
