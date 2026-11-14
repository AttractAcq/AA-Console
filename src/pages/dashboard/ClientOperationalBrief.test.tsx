import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

import { ClientOperationalBrief } from "./ClientOperationalBrief";

const reads: { table: string; clientId?: string }[] = [];
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      let status = "";
      const query = {
        select: () => query,
        eq: (key: string, value: string) => {
          if (key === "client_id") reads.push({ table, clientId: value });
          if (key === "status" || key === "execution_status") status = value;
          return query;
        },
        neq: () => query,
        in: () => query,
        limit: () => query,
        then: (resolve: (value: unknown) => void) => {
          if (table === "approval_inbox_v6") {
            resolve(status === "stale"
              ? { count: null, error: { message: "stale approval read denied" } }
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
  expect(await screen.findByText(/2 pending · unknown stale/)).toBeInTheDocument();
  expect(screen.getByText("Lead magnet deliveries owed").parentElement).toHaveTextContent("3 Open studio");
  expect(screen.getByRole("alert")).toHaveTextContent("stale approval read denied");
  expect(screen.getByText(/meta: connected/)).toHaveTextContent("no check recorded");
  expect(reads).toHaveLength(8);
  expect(reads.every((read) => read.clientId === "client-1")).toBe(true);
});
