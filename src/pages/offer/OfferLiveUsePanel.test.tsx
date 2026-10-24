import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reprice case.
 *
 * A client moves from v2 to v3, every new asset is correct, and something
 * live keeps carrying v2. That row has to be first, has to be coloured, and
 * has to say so in words — because it is the only one anybody needs to act on
 * today, and it is invisible everywhere else in the console.
 */

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("react-router-dom", () => ({ useParams: () => ({ clientId: "client-1" }) }));

import { OfferLiveUsePanel } from "./OfferLiveUsePanel";

const drift = (over: Record<string, unknown> = {}) => ({
  client_id: "client-1", offer_id: "offer-1", service_name: "Garage conversion",
  offer_version_id: "ver-1", version: 1, current_version: 2,
  surface: "lead_magnet", record_id: "mag-1", label: "Cost guide",
  live: true, live_note: null, superseded: true,
  drift: "Carrying v1 while v2 is current, and it is live.", ...over,
});

const claim = (over: Record<string, unknown> = {}) => ({
  client_id: "client-1", offer_id: "offer-1", offer_version_id: "ver-2", version: 2,
  position: 1, kind: "quantified", claim_text: "Dry in four days",
  proof_asset_id: "proof-1", proof_title: "Four-day conversion",
  usage_rights: "approved", expires_on: null, problem: null, ...over,
});

function database(rows: unknown[], claims: unknown[] = []) {
  from.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: async () => ({
        data: table === "offer_version_drift" ? rows : claims,
        error: null,
      }),
    });
    return chain;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the expensive row", () => {
  it("counts and colours a live surface carrying a superseded offer", async () => {
    database([drift()]);
    render(<OfferLiveUsePanel />);
    expect(
      await screen.findByText("1 live surface is carrying a superseded offer"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Carrying v1 while v2 is current, and it is live."),
    ).toBeInTheDocument();
    expect(screen.getByText("current is v2")).toBeInTheDocument();
  });

  it("sorts superseded-and-live above merely superseded, and current last", async () => {
    database([
      drift({ label: "Current page", surface: "campaign_page", version: 2, superseded: false, drift: null, live: true }),
      drift({ label: "Behind but dark", live: false, drift: "Carrying v1 while v2 is current." }),
      drift({ label: "Behind and live" }),
    ]);
    render(<OfferLiveUsePanel />);
    await screen.findByText("Behind and live");
    // The matched cell carries its surface subtitle too, so compare the
    // label each row starts with rather than the whole cell.
    const order = screen
      .getAllByText(/^(Behind and live|Behind but dark|Current page)/)
      .map((node) => node.textContent?.replace(/(live|dark|page).*$/, "$1"));
    expect(order).toEqual(["Behind and live", "Behind but dark", "Current page"]);
  });

  it("says plainly when nothing live is behind", async () => {
    database([drift({ superseded: false, drift: null, version: 2 })]);
    render(<OfferLiveUsePanel />);
    expect(
      await screen.findByText("Nothing live is carrying a superseded offer"),
    ).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
  });

  it("shows unknown rather than guessing at a campaign's live state", async () => {
    database([
      drift({
        surface: "campaign", label: "Winter push", live: null,
        live_note: "A v6 campaign's live state is gated elsewhere, so this view does not claim it.",
      }),
    ]);
    render(<OfferLiveUsePanel />);
    expect(await screen.findByText("unknown")).toBeInTheDocument();
  });
});

describe("claims and their proof", () => {
  it("reports a claim whose proof expired after the sign-off", async () => {
    database(
      [drift()],
      [
        claim({
          problem: "Permission for the proof behind this claim expired on 2026-09-01.",
          expires_on: "2026-09-01",
        }),
      ],
    );
    render(<OfferLiveUsePanel />);
    expect(await screen.findByText(/1 claim no longer has usable proof/)).toBeInTheDocument();
    expect(
      screen.getByText("Permission for the proof behind this claim expired on 2026-09-01."),
    ).toBeInTheDocument();
    expect(screen.getByText("expires 2026-09-01")).toBeInTheDocument();
  });

  it("says a sound claim is fine rather than leaving it blank", async () => {
    database([drift()], [claim()]);
    render(<OfferLiveUsePanel />);
    expect(await screen.findByText("Fine")).toBeInTheDocument();
    expect(screen.getByText("Four-day conversion")).toBeInTheDocument();
  });

  it("shows a quantified claim with no proof at all", async () => {
    database(
      [drift()],
      [claim({ proof_asset_id: null, proof_title: null, problem: "A quantified claim with no proof recorded." })],
    );
    render(<OfferLiveUsePanel />);
    expect(await screen.findByText("A quantified claim with no proof recorded.")).toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();
  });
});
