import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));

import { MetaBuildSection, type MetaCampaign } from "./MetaBuildSection";

/** A query builder that answers every chain with one row. */
function answering(row: unknown, updates?: Record<string, unknown>[], updateError?: { code?: string; message: string }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
  chain.maybeSingle = () => Promise.resolve({ data: row, error: null });
  chain.update = (values: Record<string, unknown>) => {
    updates?.push(values);
    return { eq: () => Promise.resolve({ error: updateError ?? null }) };
  };
  return chain;
}

const campaign = (over: Partial<MetaCampaign> = {}): MetaCampaign => ({
  id: "camp-1",
  name: "Open day",
  template: "O2",
  mirrors_template: null,
  daily_budget: 50,
  target_countries: ["ZA"],
  conversion_event: null,
  meta_campaign_id: null,
  meta_ad_set_id: null,
  meta_built_at: null,
  ...over,
});

beforeEach(() => {
  from.mockReset();
  rpc.mockReset();
  from.mockImplementation((table: string) =>
    table === "client_integrations"
      ? answering({ status: "connected", ad_account_id: "act_9", meta_page_id: "77", meta_pixel_id: null })
      : answering(null),
  );
});

describe("MetaBuildSection", () => {
  it("shows what is in place before anyone presses Build", async () => {
    render(<MetaBuildSection clientId="c" campaign={campaign()} building={false} onChanged={vi.fn()} />);
    expect(await screen.findByText("act_9 · page 77")).toBeInTheDocument();
    expect(screen.getByText("50 a day in ZA")).toBeInTheDocument();
    expect(screen.getByText(/O2 · Event or webinar/)).toBeInTheDocument();
  });

  it("says why a template cannot be built", () => {
    render(<MetaBuildSection clientId="c" campaign={campaign({ template: "P3" })} building={false} onChanged={vi.fn()} />);
    expect(screen.getByText(/P3 sends people to message, which cannot be built yet/)).toBeInTheDocument();
  });

  it("queues a paused build through the guarded RPC", async () => {
    rpc.mockResolvedValue({ data: "job-1", error: null });
    const onChanged = vi.fn();
    render(<MetaBuildSection clientId="c" campaign={campaign()} building={false} onChanged={onChanged} />);

    await userEvent.click(screen.getByRole("button", { name: "Build in Meta (paused)" }));

    expect(rpc).toHaveBeenCalledWith("request_meta_build", { p_campaign_id: "camp-1" });
    expect(await screen.findByRole("status")).toHaveTextContent(/created paused/);
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows the refusal when a build is already running", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "A Meta build for this campaign is already queued or running." } });
    render(<MetaBuildSection clientId="c" campaign={campaign()} building={false} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Build in Meta (paused)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already queued or running/);
  });

  it("cannot be pressed while a build is in flight", () => {
    render(<MetaBuildSection clientId="c" campaign={campaign()} building onChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Building in Meta…" })).toBeDisabled();
  });

  it("links a built campaign to Ads Manager", async () => {
    render(
      <MetaBuildSection
        clientId="c"
        campaign={campaign({ meta_campaign_id: "555", meta_built_at: "2026-09-23T10:00:00Z" })}
        building={false}
        onChanged={vi.fn()}
      />,
    );
    const link = await screen.findByRole("link", { name: "Open in Ads Manager" });
    expect(link).toHaveAttribute("href", expect.stringContaining("act=9&selected_campaign_ids=555"));
    expect(screen.getByRole("button", { name: "Build again (paused)" })).toBeInTheDocument();
  });

  it("shows why the last build failed", async () => {
    from.mockImplementation((table: string) =>
      table === "agent_jobs"
        ? answering({ status: "failed", error: "Nothing was sent to Meta. Fix these first:\n- Set a daily budget for this campaign.", completed_at: null })
        : answering(null),
    );
    render(<MetaBuildSection clientId="c" campaign={campaign()} building={false} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Set a daily budget/));
  });
  it("records a structure somebody built in Ads Manager by hand", async () => {
    const updates: Record<string, unknown>[] = [];
    from.mockImplementation((table: string) =>
      table === "client_integrations"
        ? answering({ status: "connected", ad_account_id: "act_9", meta_page_id: "77", meta_pixel_id: null })
        : answering(null, updates),
    );
    const onChanged = vi.fn();
    render(<MetaBuildSection clientId="c" campaign={campaign()} building={false} onChanged={onChanged} />);

    await userEvent.click(screen.getByRole("button", { name: "Record a hand build" }));
    await userEvent.type(screen.getByLabelText(/Meta campaign id/), "120200");
    await userEvent.type(screen.getByLabelText(/Ad set id/), "120300");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ meta_campaign_id: "120200", meta_ad_set_id: "120300" });
    expect(updates[0].meta_built_at).toEqual(expect.any(String));
    expect(onChanged).toHaveBeenCalled();
  });

  it("refuses an id that is not one, rather than storing something reporting cannot match", async () => {
    const updates: Record<string, unknown>[] = [];
    from.mockImplementation((table: string) =>
      table === "client_integrations"
        ? answering({ status: "connected", ad_account_id: "act_9", meta_page_id: "77", meta_pixel_id: null })
        : answering(null, updates),
    );
    render(<MetaBuildSection clientId="c" campaign={campaign()} building={false} onChanged={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Record a hand build" }));
    await userEvent.type(screen.getByLabelText(/Meta campaign id/), "act_9");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByText(/That is an ad account id/)).toBeInTheDocument();
    expect(updates).toHaveLength(0);
  });

  it("names the clash when that Meta campaign is already recorded elsewhere", async () => {
    from.mockImplementation((table: string) =>
      table === "client_integrations"
        ? answering({ status: "connected", ad_account_id: "act_9", meta_page_id: "77", meta_pixel_id: null })
        : answering(null, [], { code: "23505", message: "duplicate key value violates unique constraint" }),
    );
    render(<MetaBuildSection clientId="c" campaign={campaign()} building={false} onChanged={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Record a hand build" }));
    await userEvent.type(screen.getByLabelText(/Meta campaign id/), "120200");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByText(/already recorded as that Meta campaign/)).toBeInTheDocument();
  });
  it("queues the manual build sheet without touching Meta", async () => {
    rpc.mockResolvedValue({ data: "job-2", error: null });
    const onChanged = vi.fn();
    render(<MetaBuildSection clientId="c" campaign={campaign()} building={false} onChanged={onChanged} />);

    await userEvent.click(screen.getByRole("button", { name: "Write build sheet" }));

    expect(rpc).toHaveBeenCalledWith("request_meta_build_sheet", { p_campaign_id: "camp-1" });
    expect(await screen.findByRole("status")).toHaveTextContent(/sends nothing to Meta/);
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows the refusal when a sheet is already being written", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "A build sheet for this campaign is already queued or running." },
    });
    render(<MetaBuildSection clientId="c" campaign={campaign()} building={false} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Write build sheet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already queued or running/);
  });

  it("offers the sheet even while a build is in flight, since it sends nothing", () => {
    render(<MetaBuildSection clientId="c" campaign={campaign()} building onChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Write build sheet" })).not.toBeDisabled();
  });
});
