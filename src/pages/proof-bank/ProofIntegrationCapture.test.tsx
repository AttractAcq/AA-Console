import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const { from, rpc, readReviews } = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), readReviews: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) =>
    <a href={to}>{children}</a>,
}));

import { ProofIntegrationCapture } from "./ProofIntegrationCapture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  from.mockImplementation(() => ({
    select: () => ({
      eq: (_field: string, clientId: string) => ({
        order: () => ({ limit: () => readReviews(clientId) }),
      }),
    }),
  }));
});

it("never displays the previous client's reviews while the new read fails", async () => {
  const second = deferred<{ data: null; error: { message: string } }>();
  readReviews.mockImplementation((clientId: string) => clientId === "client-a"
    ? Promise.resolve({ data: [{ id: "review-a", author_name: "Client A reviewer",
      comment: "Private A review", review_url: "https://example.test/a",
      reviewed_at: "2026-11-01", star_rating: 5, gone_at: null, captured_proof_id: null }], error: null })
    : second.promise);
  const view = render(<ProofIntegrationCapture clientId="client-a" />);
  expect(await screen.findByText("Private A review")).toBeInTheDocument();
  view.rerender(<ProofIntegrationCapture clientId="client-b" />);
  expect(screen.queryByText("Private A review")).not.toBeInTheDocument();
  expect(screen.getByText("Loading reviews…")).toBeInTheDocument();
  await act(async () => second.resolve({ data: null, error: { message: "Read denied" } }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Read denied");
  expect(screen.queryByText("Private A review")).not.toBeInTheDocument();
});

it("ignores an older client response after a newer client has loaded", async () => {
  const first = deferred<{ data: unknown[]; error: null }>();
  const second = deferred<{ data: unknown[]; error: null }>();
  readReviews.mockImplementation((clientId: string) => clientId === "client-a"
    ? first.promise : second.promise);
  const view = render(<ProofIntegrationCapture clientId="client-a" />);
  await waitFor(() => expect(readReviews).toHaveBeenCalledWith("client-a"));
  view.rerender(<ProofIntegrationCapture clientId="client-b" />);
  await waitFor(() => expect(readReviews).toHaveBeenCalledWith("client-b"));
  await act(async () => second.resolve({ data: [{ id: "review-b", author_name: "B",
    comment: "Current B review", review_url: null, reviewed_at: null,
    star_rating: null, gone_at: null, captured_proof_id: null }], error: null }));
  expect(screen.getByText("Current B review")).toBeInTheDocument();
  await act(async () => first.resolve({ data: [{ id: "review-a", author_name: "A",
    comment: "Late A review", review_url: null, reviewed_at: null,
    star_rating: null, gone_at: null, captured_proof_id: null }], error: null }));
  expect(screen.getByText("Current B review")).toBeInTheDocument();
  expect(screen.queryByText("Late A review")).not.toBeInTheDocument();
});
