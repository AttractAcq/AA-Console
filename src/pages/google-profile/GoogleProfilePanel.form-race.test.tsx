import { act, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

// Keep the real FormModal mounted: its pending handleSubmit used to close a
// newly opened form when an earlier save finished after Cancel.
const { from, rpc, insert } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), insert: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-1" }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

import { GoogleProfilePanel } from "./GoogleProfilePanel";

function deferredSave() {
  let resolve!: (value: { error: null }) => void;
  const promise = new Promise<{ error: null }>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  from.mockImplementation((table: string) => {
    const data = table === "google_reviews" ? [{
      id: "review-1", client_id: "client-1", location_id: "location-1",
      author_name: "Reviewer A", comment: "A good job", star_rating: 5,
      reviewed_at: "2026-10-24T09:00:00Z", captured_proof_id: null, gone_at: null,
    }] : [];
    const result = () => ({ data, error: null });
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, order: () => chain,
      limit: async () => result(),
      then: (...args: Parameters<Promise<unknown>["then"]>) =>
        Promise.resolve(result()).then(...args),
      insert: (value: unknown) => insert(value),
    });
    return chain;
  });
  insert.mockResolvedValue({ error: null });
  rpc.mockResolvedValue({ error: null });
});

it("does not close a new Connect draft when a cancelled save finishes", async () => {
  const firstSave = deferredSave();
  insert.mockReturnValueOnce(firstSave.promise);
  render(<GoogleProfilePanel tab="location" />);
  await userEvent.click(screen.getByRole("button", { name: "Connect a location" }));
  const firstForm = screen.getByRole("dialog", { name: "Connect a Business Profile location" });
  await userEvent.type(within(firstForm).getByRole("textbox", { name: "Location" }), "accounts/a/locations/1");
  await userEvent.type(within(firstForm).getByRole("textbox", { name: "What it is called" }), "First draft");
  await userEvent.click(within(firstForm).getByRole("button", { name: "Connect" }));
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ title: "First draft" }));

  await userEvent.click(within(firstForm).getByRole("button", { name: "Cancel" }));
  await userEvent.click(within(firstForm).getByRole("button", { name: "Leave form" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Connect a location" }));
  const nextForm = screen.getByRole("dialog", { name: "Connect a Business Profile location" });
  await userEvent.type(within(nextForm).getByRole("textbox", { name: "Location" }), "accounts/a/locations/2");
  await userEvent.type(within(nextForm).getByRole("textbox", { name: "What it is called" }), "Second draft");

  await act(async () => { firstSave.resolve({ error: null }); await firstSave.promise; });
  expect(screen.getByRole("dialog", { name: "Connect a Business Profile location" })).toBeInTheDocument();
  expect(within(nextForm).getByRole("textbox", { name: "What it is called" }))
    .toHaveValue("Second draft");
  expect(insert).toHaveBeenCalledTimes(1);
});

it("does not close a new Reply draft when a cancelled reply save finishes", async () => {
  const firstSave = deferredSave();
  rpc.mockReturnValueOnce(firstSave.promise);
  render(<GoogleProfilePanel tab="reviews" />);
  await userEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Draft a reply" }));
  const firstForm = screen.getByRole("dialog", { name: "Reply to Reviewer A" });
  await userEvent.type(within(firstForm).getByRole("textbox", { name: "Reply" }), "First reply");
  await userEvent.click(within(firstForm).getByRole("button", { name: "Save the draft" }));
  expect(rpc).toHaveBeenCalledWith("draft_google_review_reply_v6", {
    p_review_id: "review-1", p_body: "First reply",
  });

  await userEvent.click(within(firstForm).getByRole("button", { name: "Cancel" }));
  await userEvent.click(within(firstForm).getByRole("button", { name: "Leave form" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^Actions for / }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Draft a reply" }));
  const nextForm = screen.getByRole("dialog", { name: "Reply to Reviewer A" });
  await userEvent.type(within(nextForm).getByRole("textbox", { name: "Reply" }), "Second reply");

  await act(async () => { firstSave.resolve({ error: null }); await firstSave.promise; });
  expect(screen.getByRole("dialog", { name: "Reply to Reviewer A" })).toBeInTheDocument();
  expect(within(nextForm).getByRole("textbox", { name: "Reply" })).toHaveValue("Second reply");
  expect(rpc).toHaveBeenCalledTimes(1);
});
