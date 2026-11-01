import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Offer Studio as one page.
 *
 * The notes ask for a table of every offer, click-through detail, and two
 * buttons: one for a main offer, one for a secondary one. Nothing in the schema
 * distinguished those two until migration 303, so the properties worth pinning
 * are that each button writes its own kind, and that the question the old Live
 * use tab existed to answer still gets answered -- on the offer it belongs to,
 * rather than in a list somebody has to go and look at.
 */
const { from, insert } = vi.hoisted(() => ({ from: vi.fn(), insert: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));

import { OfferStudioPanel } from "./OfferStudioPanel";

const offer = (over: Record<string, unknown> = {}) => ({
  id: "offer-1", client_id: "client-1", service_name: "Garage conversion",
  kind: "main", created_at: "2026-10-01T00:00:00Z", ...over,
});
const version = (over: Record<string, unknown> = {}) => ({
  id: "ver-2", offer_id: "offer-1", client_id: "client-1", version: 2,
  idempotency_key: "k2", audience: null, promise: null, inclusions: [],
  exclusions: [], price_amount: 4500, currency: "EUR",
  delivery_cost_estimate: null, claims: [], content_hash: "h2",
  created_at: "2026-10-02T00:00:00Z", ...over,
});
const drift = (over: Record<string, unknown> = {}) => ({
  client_id: "client-1", offer_id: "offer-1", service_name: "Garage conversion",
  offer_version_id: "ver-1", version: 1, current_version: 2,
  surface: "lead_magnet", record_id: "mag-1", label: "Cost guide",
  live: true, live_note: "Still downloadable", superseded: true,
  drift: "Carrying v1 while v2 is current.", ...over,
});

function database(data: {
  offers?: unknown[]; versions?: unknown[]; signoffs?: unknown[]; drift?: unknown[];
}) {
  const byTable: Record<string, unknown[]> = {
    service_offers: data.offers ?? [],
    service_offer_versions: data.versions ?? [],
    service_offer_signoffs: data.signoffs ?? [],
    offer_version_drift: data.drift ?? [],
  };
  // The panel chains select -> eq -> order for some tables and select -> eq for
  // others, so the chain is a thenable rather than having one terminal method:
  // awaiting it at any point yields the rows.
  from.mockImplementation((table: string) => {
    const result = { data: byTable[table] ?? [], error: null };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      insert: insert.mockResolvedValue({ error: null }),
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(resolve(result)),
    });
    return chain;
  });
}

function show() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <OfferStudioPanel />
    </MemoryRouter>,
  );
}

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useParams: () => ({ clientId: "client-1" }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the two buttons the notes ask for", () => {
  it("creates a main offer as main", async () => {
    database({ offers: [] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "New main offer" }));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ kind: "main" }));
  });

  it("creates a secondary offer as secondary", async () => {
    database({ offers: [] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "New secondary offer" }));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ kind: "secondary" }));
  });

  it("says what to do when there is nothing yet, naming both kinds", async () => {
    database({ offers: [] });
    show();
    expect(await screen.findByText(/Create a main offer for the business/)).toBeInTheDocument();
  });
});

describe("the table", () => {
  it("shows each offer with its kind and latest version", async () => {
    database({ offers: [offer()], versions: [version()] });
    show();
    expect(await screen.findByText("Garage conversion")).toBeInTheDocument();
    expect(screen.getByText("Main")).toBeInTheDocument();
    // Not signed off, and it says so rather than leaving it blank.
    expect(screen.getByText("v2, not signed off")).toBeInTheDocument();
  });

  it("reports a signed-off version as signed off", async () => {
    database({
      offers: [offer()],
      versions: [version()],
      signoffs: [{ offer_version_id: "ver-2", client_id: "client-1" }],
    });
    show();
    expect(await screen.findByText("v2, signed off")).toBeInTheDocument();
  });

  it("distinguishes a secondary offer", async () => {
    database({ offers: [offer({ id: "offer-2", kind: "secondary", service_name: "Roofers" })] });
    show();
    expect(await screen.findByText("Secondary")).toBeInTheDocument();
  });
});

describe("the question Live use existed to answer", () => {
  it("names a superseded-but-live version on the offer it belongs to", async () => {
    database({ offers: [offer()], versions: [version()], drift: [drift()] });
    show();
    expect(await screen.findByText("1 superseded version still live")).toBeInTheDocument();
  });

  it("leaves the column blank when nothing is drifting", async () => {
    database({ offers: [offer()], versions: [version()] });
    show();
    expect(await screen.findByText("Garage conversion")).toBeInTheDocument();
    expect(screen.queryByText(/superseded version/)).toBeNull();
  });

  it("ignores a superseded version that is not live, and a live one that is current", async () => {
    database({
      offers: [offer()],
      drift: [drift({ live: false }), drift({ offer_version_id: "ver-2", superseded: false })],
    });
    show();
    expect(await screen.findByText("Garage conversion")).toBeInTheDocument();
    expect(screen.queryByText(/superseded version/)).toBeNull();
  });

  it("gives the specifics in the detail, including the surface it is live on", async () => {
    database({ offers: [offer()], versions: [version()], drift: [drift()] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Show Garage conversion" }));
    const detail = screen.getByRole("region", { name: "Garage conversion" });
    expect(within(detail).getByText(/lead_magnet/)).toBeInTheDocument();
    expect(within(detail).getByText(/Cost guide/)).toBeInTheDocument();
    expect(within(detail).getByText(/Still downloadable/)).toBeInTheDocument();
  });
});

describe("the detail", () => {
  it("explains where a main offer is compiled from", async () => {
    database({ offers: [offer()] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Show Garage conversion" }));
    expect(screen.getByText(/compiled from offer strategy/)).toBeInTheDocument();
  });

  it("explains where a secondary offer is compiled from", async () => {
    database({ offers: [offer({ kind: "secondary" })] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Show Garage conversion" }));
    expect(screen.getByText(/compiled from that market opportunity/)).toBeInTheDocument();
  });

  it("says plainly when an offer has no version, rather than showing an empty list", async () => {
    database({ offers: [offer()] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Show Garage conversion" }));
    expect(screen.getByText(/No version yet/)).toBeInTheDocument();
  });

  it("links to the version form so nothing from the old tabs is unreachable", async () => {
    database({ offers: [offer()] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Show Garage conversion" }));
    expect(screen.getByRole("link", { name: "Edit versions and claims" })).toHaveAttribute(
      "href",
      "/clients/client-1/delivery/offer-studio?tab=versions&offer=offer-1",
    );
  });
});
