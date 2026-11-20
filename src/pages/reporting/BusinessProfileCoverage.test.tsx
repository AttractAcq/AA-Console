import { render, screen, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("react-router-dom", () => ({ Link: ({ to, children }: { to: string; children: string }) =>
  <a href={to}>{children}</a> }));

import { BusinessProfileCoverage } from "./BusinessProfileCoverage";

function reads(locations: unknown[], runs: unknown[], failure = false) {
  from.mockImplementation((table: string) => ({
    select: () => ({ eq: () => Promise.resolve({
      data: table === "client_google_locations" ? locations : runs,
      error: failure ? { message: "denied" } : null,
    }) }),
  }));
}

beforeEach(() => { vi.clearAllMocks(); });

describe("Business Profile coverage", () => {
  it("keeps absent location data unknown", async () => {
    reads([], []);
    render(<BusinessProfileCoverage clientId="client-1" />);
    expect(await screen.findByText(/no location recorded; metrics unknown/)).toBeInTheDocument();
  });

  it("counts current-bound reads separately from Google Ads", async () => {
    reads([{ id: "loc-1" }, { id: "loc-2" }],
      [{ location_id: "loc-1", fetched_at: "2026-11-19T10:00:00Z" }]);
    render(<BusinessProfileCoverage clientId="client-1" />);
    expect(await screen.findByText(/1 of 2 recorded locations have a current-bound read/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Google Studio metrics" }))
      .toHaveAttribute("href", "/clients/client-1/google-profile?tab=metrics");
  });

  it("does not present a failed read as zero coverage", async () => {
    reads([], [], true);
    render(<BusinessProfileCoverage clientId="client-1" />);
    expect(await screen.findByText(/coverage unknown; the current profile read could not be verified/)).toBeInTheDocument();
  });

  it("ignores a previous client's late response", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    from.mockImplementation((_table: string) => ({ select: () => ({
      eq: (_field: string, clientId: string) => clientId === "client-1"
        ? gate.then(() => ({ data: [{ id: "old" }], error: null }))
        : Promise.resolve({ data: [], error: null }),
    }) }));
    const view = render(<BusinessProfileCoverage key="client-1" clientId="client-1" />);
    view.rerender(<BusinessProfileCoverage key="client-2" clientId="client-2" />);
    expect(await screen.findByText(/no location recorded; metrics unknown/)).toBeInTheDocument();
    await act(async () => { release(); });
    expect(screen.queryByText(/1 of 1 recorded locations/)).not.toBeInTheDocument();
  });
});
