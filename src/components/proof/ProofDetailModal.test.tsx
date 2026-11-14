import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

import type { ProofAsset } from "../../lib/media";
import { ProofDetailModal } from "./ProofDetailModal";

const { update, rpc } = vi.hoisted(() => ({ update: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: {
  from: () => ({ update: (payload: unknown) => {
    update(payload);
    return { eq: async () => ({ error: null }) };
  } }),
  rpc: (...args: unknown[]) => rpc(...args),
} }));

const proof = (over: Record<string, unknown> = {}) => ({
  id: "proof-1", client_id: "client-1", media_type: "text",
  title: "Customer result", body: "Delivered on time", storage_path: null,
  proof_type: "testimonial", claim: "On time", evidence: "Signed note",
  avatar_relevance: null, services: null, strength: "medium",
  usage_rights: "not_cleared", permission_basis: null,
  approved_rights_request_id: null, captured_on: null, expires_on: null,
  ...over,
}) as ProofAsset;

beforeEach(() => {
  update.mockClear();
  rpc.mockReset().mockResolvedValue({ data: "request-1", error: null });
});

it("saves source words and requests clearance without directly granting rights", async () => {
  const onSaved = vi.fn();
  render(<MemoryRouter><ProofDetailModal proof={proof()} open onClose={vi.fn()} onSaved={onSaved} /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: /Request clearance/ }));
  await userEvent.type(screen.getByLabelText("Permission basis"), "Customer signed release");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("request_proof_rights_v6", {
    p_proof_id: "proof-1", p_permission_basis: "Customer signed release",
  }));
  expect(update.mock.calls[0][0]).not.toHaveProperty("usage_rights");
  expect(update.mock.calls[0][0]).not.toHaveProperty("permission_basis");
  expect(await screen.findByRole("status")).toHaveTextContent("remains uncleared");
  expect(onSaved).toHaveBeenCalled();
});

it("lets a manager restrict an existing clearance immediately", async () => {
  render(<MemoryRouter><ProofDetailModal proof={proof({ usage_rights: "approved",
    approved_rights_request_id: "request-old", permission_basis: "Old consent" })}
    open onClose={vi.fn()} onSaved={vi.fn()} /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: /Restricted/ }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalled());
  expect(update.mock.calls[0][0]).toHaveProperty("usage_rights", "restricted");
  expect(rpc).not.toHaveBeenCalled();
});
