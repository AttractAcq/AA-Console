import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, useParams } = vi.hoisted(() => ({ from: vi.fn(), useParams: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("react-router-dom", () => ({ useParams }));
vi.mock("../../components/MetricsBackfill", () => ({ MetricsBackfill: () => null }));
vi.mock("../../components/forms/FormModal", () => ({ FormModal: () => null }));

import { IntegrationsPanel } from "./IntegrationsPanel";

const base = (status: string) => ({
  id: "i1", provider: "instagram", credential_label: "ig-123", access_level: null,
  status, ingest_enabled: true, last_checked_at: null, ad_account_id: null,
  meta_page_id: null, meta_pixel_id: null,
});

function show(
  integration: Record<string, unknown>,
  health: Record<string, unknown> | null,
) {
  from.mockImplementation((table: string) => {
    const result = {
      data: table === "client_integrations" ? [integration] : health ? [health] : [],
      error: null,
    };
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    };
    return chain;
  });
  render(<IntegrationsPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
});

describe("Account integration eligibility", () => {
  it("shows a usable expiring token as a warning and leaves daily sync eligible", async () => {
    show(base("expiring"), {
      integration_id: "i1", usable: true, headline: "Expiring soon",
      health_detail: "Reconnect before it expires.", token_expires_at: "2026-11-03T00:00:00Z",
    });
    expect(await screen.findByText(/expiring · Expiring soon/)).toBeInTheDocument();
    expect(screen.getByText("Reconnect before it expires.")).toBeInTheDocument();
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.queryByText(/waiting for credential/)).not.toBeInTheDocument();
  });

  it("shows a stale active label as unusable when the SQL health gate says expired", async () => {
    show(base("active"), {
      integration_id: "i1", usable: false, headline: "Expired",
      health_detail: "Token expired.", token_expires_at: "2026-10-29T00:00:00Z",
    });
    expect(await screen.findByText(/active · Expired/)).toBeInTheDocument();
    expect(screen.getByText("On · waiting for credential")).toBeInTheDocument();
    expect(screen.getByText(/Onboarding is waiting on:/)).toBeInTheDocument();
  });

  it("fails closed when the health view does not return a matching row", async () => {
    show(base("connected"), null);
    expect(await screen.findByText(/connected · Health unavailable/)).toBeInTheDocument();
    expect(screen.getByText("On · waiting for credential")).toBeInTheDocument();
  });
});
