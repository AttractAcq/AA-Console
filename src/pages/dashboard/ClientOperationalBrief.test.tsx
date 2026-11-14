import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

import { ClientOperationalBrief } from "./ClientOperationalBrief";

const reads: { table: string; clientId?: string }[] = [];
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
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
          } else {
            resolve({ data: [{ provider: "meta", status: "connected", last_checked_at: null }], error: null });
          }
        },
      };
      return query;
    },
  },
}));

it("keeps failed source counts unknown and scopes every brief read to its client", async () => {
  reads.length = 0;
  render(<MemoryRouter><ClientOperationalBrief clientId="client-1" spend={1.25} failedRuns={1} activeRuns={0} /></MemoryRouter>);
  expect(await screen.findByText(/2 pending · 2 source held · unknown stale/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Review source proof" })).toHaveAttribute("href", "/clients/client-1/delivery/proof-production");
  expect(screen.getByText(/Permission expired/)).toBeInTheDocument();
  expect(screen.getByText("Lead magnet deliveries owed").parentElement).toHaveTextContent("3 Open studio");
  expect(screen.getByRole("alert")).toHaveTextContent("stale approval read denied");
  expect(screen.getByText(/meta: connected/)).toHaveTextContent("no check recorded");
  expect(reads).toHaveLength(10);
  expect(reads.every((read) => read.clientId === "client-1")).toBe(true);
});
