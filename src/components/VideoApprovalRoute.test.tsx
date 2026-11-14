import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const { rpc, from, requestVideoSeatReview } = vi.hoisted(() => ({
  rpc: vi.fn(), from: vi.fn(), requestVideoSeatReview: vi.fn(),
}));
vi.mock("../lib/supabase", () => ({ supabase: { rpc, from } }));
vi.mock("../lib/creativeReview", () => ({ requestVideoSeatReview }));
import { VideoApprovalRoute } from "./VideoApprovalRoute";

beforeEach(() => { rpc.mockReset(); from.mockReset(); requestVideoSeatReview.mockReset();
  requestVideoSeatReview.mockResolvedValue("request-1"); });

it("requires the assigned owner sign-off before final approval appears", async () => {
  rpc.mockImplementation(() => {
    return Promise.resolve({ data: {
      owner_user_id: "owner", manager_user_id: "smm", client_user_id: null,
      owner_approved: false, manager_approved: true, client_approved: false,
      can_configure: false, current_user_id: "owner", client_accounts: [],
    }, error: null });
  });
  const finalApprove = vi.fn();
  render(<MemoryRouter><VideoApprovalRoute clientId="client-1" assetId="video-1"
    onFinalApprove={finalApprove} /></MemoryRouter>);
  expect(await screen.findByRole("button", { name: "Request owner signoff" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Final approve" })).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Request owner signoff" }));
  await waitFor(() => expect(screen.getByRole("link", { name: "Open Unified Inbox" })).toHaveAttribute(
    "href", "/clients/client-1/delivery/approval-inbox?tab=unified"));
  expect(finalApprove).not.toHaveBeenCalled();
  expect(requestVideoSeatReview).toHaveBeenCalledWith("client-1", "video-1", "owner");
});

it("lets an admin change the configured owner account", async () => {
  rpc.mockImplementation((name: string) => Promise.resolve(name === "video_approval_state"
    ? { data: { owner_user_id: "old", manager_user_id: "smm", client_user_id: null,
      owner_approved: false, manager_approved: false, client_approved: false,
      can_configure: true, current_user_id: "old", client_accounts: [] }, error: null }
    : { data: null, error: null }));
  const chain: Record<string, unknown> = {};
  Object.assign(chain, { select: () => chain, eq: () => chain,
    order: () => Promise.resolve({ data: [
      { id: "old", full_name: "Old owner", email: null },
      { id: "new", full_name: "New owner", email: null },
    ], error: null }) });
  from.mockReturnValue(chain);
  render(<MemoryRouter><VideoApprovalRoute clientId="client-1" assetId="video-1"
    onFinalApprove={vi.fn()} /></MemoryRouter>);
  await userEvent.setup().selectOptions(await screen.findByRole("combobox", { name: "Owner account" }), "new");
  await userEvent.setup().click(screen.getByRole("button", { name: "Save owner" }));
  expect(rpc).toHaveBeenCalledWith("set_content_approval_owner", { p_user_id: "new" });
});

it("shows the SMM when the client request is in-app but email was skipped", async () => {
  rpc.mockImplementation((name: string) => Promise.resolve(name === "video_approval_state"
    ? { data: { owner_user_id: "owner", manager_user_id: "smm", client_user_id: "client",
      owner_approved: true, manager_approved: true, client_approved: false,
      client_rejection_reason: null, can_configure: false, current_user_id: "smm",
      client_accounts: [] }, error: null }
    : { data: { status: "skipped", error: "No RESEND_API_KEY" }, error: null }));
  render(<MemoryRouter><VideoApprovalRoute clientId="client-1" assetId="video-1"
    onFinalApprove={vi.fn()} /></MemoryRouter>);
  expect(await screen.findByText(/request is in their dashboard; email not sent/i)).toBeInTheDocument();
  expect(rpc).toHaveBeenCalledWith("video_client_approval_email_state", { p_asset_id: "video-1" });
});
