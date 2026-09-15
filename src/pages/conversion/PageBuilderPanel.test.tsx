import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { from, rpc, useParams, useAgentJobs, inserts } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  useParams: vi.fn(),
  useAgentJobs: vi.fn(),
  inserts: [] as Array<{ table: string; value: unknown }>,
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
  useParams.mockReturnValue({ clientId: "client-1" });
  useAgentJobs.mockReturnValue({ inFlight: [], recentFailures: [] });
  rpc.mockResolvedValue({ error: null });
  from.mockImplementation((table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      single: () => Promise.resolve({ data: { id: "page-1" }, error: null }),
      insert: (value: unknown) => {
        inserts.push({ table, value });
        return table === "campaign_artifacts" ? Promise.resolve({ error: null }) : chain;
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({
        error: null,
        data: table === "client_campaigns" ? [campaign] : [],
      }).then(resolve),
    };
    return chain;
  });
});

it("uploads a built HTML page and links it to the selected campaign without queueing the agent", async () => {
  render(<PageBuilderPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Build Page" }));
  fireEvent.change(await screen.findByLabelText("Page title"), { target: { value: "Christmas Sale landing" } });
  await screen.findByText("Christmas Sale · planning");
  fireEvent.change(screen.getByLabelText("Campaign"), { target: { value: "campaign-1" } });
  fireEvent.change(screen.getByLabelText("Built HTML file"), {
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
  fireEvent.change(await screen.findByLabelText("Page title"), { target: { value: "Agent-built page" } });
  await screen.findByText("Christmas Sale · planning");
  fireEvent.change(screen.getByLabelText("Campaign"), { target: { value: "campaign-1" } });
  fireEvent.change(screen.getByLabelText("What this page is for"), { target: { value: "Write the festive campaign page." } });
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
  fireEvent.change(await screen.findByLabelText("Page title"), { target: { value: "No brief" } });
  fireEvent.click(screen.getByRole("button", { name: "Save page" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("required unless you upload a built HTML file");
  expect(inserts).toEqual([]);
});
