import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

import { HeldExternalJobs } from "./HeldExternalJobs";

const clientFilters: string[] = [];
let failRead = false;
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "agent_jobs") throw new Error(`Unexpected source ${table}`);
      const query = {
        select: () => query,
        eq: (column: string, value: string) => {
          if (column === "client_id") clientFilters.push(value);
          return query;
        },
        in: () => query,
        order: () => query,
        limit: async () => failRead ? { data: null, error: { message: "read denied" } } : ({ data: [
          { id: "a", client_id: "client-1", agent_key: "google_reply_sender", created_at: "2026-11-15T12:00:00Z" },
          { id: "b", client_id: "client-2", agent_key: "meta_profile_field_writer", created_at: "2026-11-15T11:00:00Z" },
          { id: "c", client_id: "client-1", agent_key: "unsupported_worker", created_at: "2026-11-15T10:00:00Z" },
        ], error: null }),
      };
      return query;
    },
  },
}));

it("shows only paused supported provider jobs for the selected client", async () => {
  failRead = false;
  clientFilters.length = 0;
  const { rerender } = render(<MemoryRouter><HeldExternalJobs clientId="client-1" /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: "Google review reply · held" }))
    .toHaveAttribute("href", "/clients/client-1/google-profile?tab=reviews");
  expect(screen.queryByText(/Meta Page change/)).not.toBeInTheDocument();
  expect(screen.queryByText(/unsupported/)).not.toBeInTheDocument();
  rerender(<MemoryRouter><HeldExternalJobs clientId="client-2" /></MemoryRouter>);
  expect(screen.queryByRole("link", { name: "Google review reply · held" })).not.toBeInTheDocument();
  expect(await screen.findByRole("link", { name: "Meta Page change · held" }))
    .toHaveAttribute("href", "/clients/client-2/meta-profile?tab=profile");
  expect(clientFilters).toEqual(["client-1", "client-2"]);
});

it("reports held-job read failures", async () => {
  failRead = true;
  render(<MemoryRouter><HeldExternalJobs clientId="client-1" /></MemoryRouter>);
  expect(await screen.findByRole("alert")).toHaveTextContent("Held jobs could not be loaded");
});
