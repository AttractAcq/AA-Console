import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useOperationalCampaigns, rpc, refresh } = vi.hoisted(() => ({
  useOperationalCampaigns: vi.fn(),
  rpc: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../campaigns/useOperationalCampaigns", () => ({ useOperationalCampaigns }));
vi.mock("../../lib/supabase", () => ({ supabase: { rpc } }));

import { CampaignsPanel } from "./CampaignsPanel";

const show = () => render(<MemoryRouter><CampaignsPanel /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  useOperationalCampaigns.mockReturnValue({
    rows: [{ id: "camp-1", client_id: "client-1", name: "Winter push", status: "planning", objective: null, channels: [], starts_on: null, ends_on: null, needs_landing_page: false, needs_sales_agent: false }],
    clients: [{ id: "client-1", name: "Example client" }],
    readiness: {}, loading: false, error: "", readinessError: "", refresh,
  });
  rpc.mockResolvedValue({ data: [], error: null });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "prompt").mockReturnValue("Winter push");
});

describe("operations campaign deletion", () => {
  it("opens the specific campaign page", () => {
    show();
    expect(screen.getByRole("link", { name: "Winter push" })).toHaveAttribute("href", "/clients/client-1/delivery/campaign-execution/camp-1");
  });

  it("requires a warning and exact name, then deletes and refreshes", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "Delete Winter push" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("delete_client_campaign", { p_campaign_id: "camp-1" }));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(String(vi.mocked(window.confirm).mock.calls[0]?.[0])).toMatch(/ideas, content briefs and generated assets/);
    expect(window.prompt).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("stops when either confirmation is declined", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    show();
    await userEvent.click(screen.getByRole("button", { name: "Delete Winter push" }));
    expect(window.prompt).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true);
    vi.mocked(window.prompt).mockReturnValue("wrong name");
    await userEvent.click(screen.getByRole("button", { name: "Delete Winter push" }));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("shows an RPC refusal and leaves the row in place", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Not authorized" } });
    show();
    await userEvent.click(screen.getByRole("button", { name: "Delete Winter push" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not authorized");
    expect(screen.getByRole("link", { name: "Winter push" })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
