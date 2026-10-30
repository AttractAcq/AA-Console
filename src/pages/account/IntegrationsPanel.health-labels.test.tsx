import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { from, useParams } = vi.hoisted(() => ({ from: vi.fn(), useParams: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("react-router-dom", () => ({ useParams }));
vi.mock("../../components/MetricsBackfill", () => ({ MetricsBackfill: () => null }));
vi.mock("../../components/forms/FormModal", () => ({ FormModal: () => null }));

import { IntegrationsPanel } from "./IntegrationsPanel";

const CHECKED_AT = "2027-01-01T12:00:00Z";
const base = {
  credential_label: "account-1", access_level: null, status: "connected",
  ingest_enabled: false, last_checked_at: CHECKED_AT, token_expires_at: null,
  ad_account_id: null, meta_page_id: null, meta_pixel_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
  from.mockImplementation(() => {
    const query = {
      select: () => query,
      eq: () => query,
      order: async () => ({ data: [
        { ...base, id: "meta-1", provider: "meta", ingest_enabled: true },
        { ...base, id: "google-1", provider: "google_business" },
        { ...base, id: "resend-1", provider: "resend" },
        { ...base, id: "instagram-1", provider: "instagram", status: "revoked", last_checked_at: null },
      ], error: null }),
    };
    return query;
  });
});

it("does not present the shared check timestamp as token proof or a completed sync", async () => {
  render(<IntegrationsPanel />);
  // Both metrics_ingest and token_health update last_checked_at. A row with
  // that value cannot identify which check ran, including for Meta.
  expect(await screen.findAllByText(/Last recorded integration check/)).toHaveLength(3);
  expect(screen.queryByText(/Token checked/)).not.toBeInTheDocument();
  expect(screen.queryByText(/On · last/)).not.toBeInTheDocument();
  expect(screen.getByText(/Provider health unknown. Exact location access/)).toBeInTheDocument();
  expect(screen.getByText(/Provider health unknown. This row does not verify/)).toBeInTheDocument();
  expect(screen.getByText(/Blocked by integration status/)).toBeInTheDocument();
});
