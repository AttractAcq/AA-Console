import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

import { ArchivedReturnAlerts } from "./ArchivedReturnAlerts";

const readClients: string[] = [];
let failRead = false;
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: (column: string, value: string) => {
          if (column === "client_id") readClients.push(value);
          return query;
        },
        is: () => query,
        not: () => query,
        order: () => query,
        limit: async () => failRead
          ? { data: null, count: null, error: { message: "read denied" } }
          : { data: table === "lead_submissions"
            ? [{ id: "form-1", created_at: "2026-11-19T10:00:00Z" }]
            : [{ id: "agent-1", started_at: "2026-11-19T11:00:00Z" }],
            count: 1, error: null },
      };
      return query;
    },
  },
}));

it("shows source-owned form and sales reviews for the requested client", async () => {
  failRead = false;
  readClients.length = 0;
  render(<MemoryRouter><ArchivedReturnAlerts clientId="client-1" /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: "Captured form · review archived contact" }))
    .toHaveAttribute("href", "/clients/client-1/delivery/sales-os?tab=capture");
  expect(screen.getByRole("link", { name: "Sales agent conversation · review archived contact" }))
    .toHaveAttribute("href", "/clients/client-1/delivery/sales-os?tab=agents");
  expect(readClients).toEqual(["client-1", "client-1"]);
  expect(screen.getByText(/source-owned AAL2 reviews/)).toBeInTheDocument();
});

it("reports a failed source read instead of displaying an empty queue", async () => {
  failRead = true;
  render(<MemoryRouter><ArchivedReturnAlerts clientId="client-2" /></MemoryRouter>);
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
