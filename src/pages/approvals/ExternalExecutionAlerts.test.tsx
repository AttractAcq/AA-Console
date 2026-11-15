import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

import { ExternalExecutionAlerts } from "./ExternalExecutionAlerts";

const clientFilters: string[] = [];
let failRead = false;
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "client_external_outcomes_v6") throw new Error(`Unexpected source ${table}`);
      const query = {
        select: () => query,
        in: () => query,
        eq: (column: string, value: string) => {
          if (column === "client_id") clientFilters.push(value);
          return query;
        },
        order: () => query,
        limit: async () => failRead ? { data: null, error: { message: "read denied" } } : ({ data: [
          { outcome_id: "a", client_id: "client-1", source_kind: "google_review_reply",
            outcome: "uncertain", occurred_at: "2026-11-15T12:00:00Z",
            owning_path: "/clients/client-1/google-profile?tab=reviews" },
          { outcome_id: "b", client_id: "client-2", source_kind: "meta_profile_change",
            outcome: "refused", occurred_at: "2026-11-15T11:00:00Z",
            owning_path: "/clients/client-2/meta-profile?tab=profile" },
          { outcome_id: "c", client_id: "client-1", source_kind: "meta_profile_change",
            outcome: "refused", occurred_at: "2026-11-15T10:00:00Z",
            owning_path: "/clients/client-2/meta-profile?tab=profile" },
          { outcome_id: "d", client_id: "client-1", source_kind: "google_review_reply",
            outcome: "unverified", occurred_at: "2026-11-15T09:00:00Z",
            owning_path: "/clients/client-1/google-profile?tab=reviews" },
        ], error: null }),
      };
      return query;
    },
  },
}));

it("links a client only to its own failed or uncertain owning source", async () => {
  failRead = false;
  clientFilters.length = 0;
  const { rerender } = render(<MemoryRouter><ExternalExecutionAlerts clientId="client-1" /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: "google review reply · uncertain" }))
    .toHaveAttribute("href", "/clients/client-1/google-profile?tab=reviews");
  expect(screen.getByRole("link", { name: "google review reply · unverified" }))
    .toHaveAttribute("href", "/clients/client-1/google-profile?tab=reviews");
  expect(screen.queryByText(/meta profile change/)).not.toBeInTheDocument();
  expect(clientFilters).toEqual(["client-1"]);
  rerender(<MemoryRouter><ExternalExecutionAlerts clientId="client-2" /></MemoryRouter>);
  expect(screen.queryByRole("link", { name: "google review reply · uncertain" })).not.toBeInTheDocument();
  expect(await screen.findByRole("link", { name: "meta profile change · refused" }))
    .toHaveAttribute("href", "/clients/client-2/meta-profile?tab=profile");
});

it("reports an outcome read failure instead of silently showing no alerts", async () => {
  failRead = true;
  render(<MemoryRouter><ExternalExecutionAlerts clientId="client-1" /></MemoryRouter>);
  expect(await screen.findByRole("alert")).toHaveTextContent("Outcome alerts could not be loaded");
});
