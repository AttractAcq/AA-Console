import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

import { ClientOperationalBrief } from "./ClientOperationalBrief";

const reads: { table: string; clientId?: string }[] = [];
let measurementReadDenied = false;
vi.mock("../../lib/supabase", () => {
  const makeQuery = (table: string) => {
      let status = "";
      let columns = "";
      const query = {
        select: (value: string) => { columns = value; return query; },
        eq: (key: string, value: string) => {
          if (key === "client_id") reads.push({ table, clientId: value });
          if (key === "status" || key === "execution_status") status = value;
          return query;
        },
        neq: () => query,
        not: () => query,
        in: () => query,
        order: () => query,
        limit: () => query,
        then: (resolve: (value: unknown) => void) => {
          if (table === "approval_inbox_v6") {
            resolve(status === "stale"
              ? { count: null, error: { message: "stale approval read denied" } }
              : columns.includes("title")
                ? { data: [{ id: "held-1", title: "Review source proof", owning_path: "/clients/client-1/delivery/proof-production", preview_blocker: "Permission expired" }], error: null }
              : { count: 2, error: null });
          } else if (table === "campaign_action_due") {
            resolve({ data: [], count: status === "executed" ? 1 : 0, error: null });
          } else if (table === "lead_magnet_deliveries") {
            resolve({ count: 3, error: null });
          } else if (table === "client_external_outcomes_v6") {
            resolve(columns === "outcome_id"
              ? { count: 2, error: null }
              : { data: [{ source_kind: "google_review_reply", outcome: "confirmed",
                occurred_at: "2026-11-15T12:00:00Z", owning_path: "/clients/client-1/google-profile?tab=reviews",
                external_ref: "accounts/a/locations/b/reviews/c" }], error: null });
          } else {
            resolve({ data: [{ provider: "meta", status: "connected", last_checked_at: null }], error: null });
          }
        },
      };
      return query;
    };
  return { supabase: {
    from: makeQuery,
    rpc: (name: string, args: { p_client_id: string; p_days?: number }) => {
      reads.push({ table: "client_external_outcomes_v6", clientId: args.p_client_id });
      if (name === "acquisition_funnel") return Promise.resolve({ data: [{ leads: 4, sales: 1 }], error: null });
      if (name === "acquisition_coverage_v8") return Promise.resolve(measurementReadDenied
        ? { data: null, error: { message: "coverage read denied" } }
        : { data: [{ sourced_leads: 3, consented_leads: 2, latest_meta_read_at: null, latest_google_read_at: null }], error: null });
      if (name !== "list_client_external_outcomes_v6") throw new Error(`Unexpected RPC ${name}`);
      return makeQuery("client_external_outcomes_v6");
    },
  } };
});

it("keeps failed source counts unknown and scopes every brief read to its client", async () => {
  reads.length = 0;
  render(<MemoryRouter><ClientOperationalBrief clientId="client-1" spend={1.25} failedRuns={1} activeRuns={0} /></MemoryRouter>);
  expect(await screen.findByText(/2 pending · 2 source held · unknown stale/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Review source proof" })).toHaveAttribute("href", "/clients/client-1/delivery/proof-production");
  expect(screen.getByText(/Permission expired/)).toBeInTheDocument();
  expect(screen.getByText("Lead magnet deliveries owed").parentElement).toHaveTextContent("3 Open studio");
  expect(screen.getByRole("alert")).toHaveTextContent("stale approval read denied");
  expect(screen.getByText(/meta: connected/)).toHaveTextContent("no check recorded");
  expect(screen.getByText("External execution").parentElement).toHaveTextContent("2 requiring reconciliation");
  expect(screen.getByRole("link", { name: /google review reply/ })).toHaveAttribute("href", "/clients/client-1/google-profile?tab=reviews");
  expect(screen.getByText("Recorded acquisition · 30 days").parentElement).toHaveTextContent("4 leads · 1 sales; 3/4 leads with source; 2/4 with recorded consent");
  expect(screen.getByText("Latest paid account inventory read").parentElement).toHaveTextContent("Meta: unknown · Google: unknown");
  expect(reads).toHaveLength(14);
  expect(reads.every((read) => read.clientId === "client-1")).toBe(true);
});

it("does not turn an unavailable job history into zero spend or failures", async () => {
  render(<MemoryRouter><ClientOperationalBrief clientId="client-1" spend={null} failedRuns={null} activeRuns={null} /></MemoryRouter>);
  expect(screen.getByText("Agent work").parentElement).toHaveTextContent("unknown active · unknown unresolved failures");
  expect(screen.getByText("Agent spend").parentElement).toHaveTextContent("unknown");
});

it("keeps acquisition counts and provider freshness unknown when coverage cannot be read", async () => {
  measurementReadDenied = true;
  try {
    render(<MemoryRouter><ClientOperationalBrief clientId="client-1" spend={null} failedRuns={null} activeRuns={null} /></MemoryRouter>);
    expect(await screen.findByText(/coverage read denied/)).toBeInTheDocument();
    expect(screen.getByText("Recorded acquisition · 30 days").parentElement).toHaveTextContent("unknown Inspect journeys");
    expect(screen.getByText("Latest paid account inventory read").parentElement).toHaveTextContent("unknown");
  } finally {
    measurementReadDenied = false;
  }
});
