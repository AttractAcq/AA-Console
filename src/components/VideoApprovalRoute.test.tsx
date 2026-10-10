import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: { rpc, from } }));
import { VideoApprovalRoute } from "./VideoApprovalRoute";

beforeEach(() => { rpc.mockReset(); from.mockReset(); });

it("requires the assigned owner sign-off before final approval appears", async () => {
  let signed = false;
  rpc.mockImplementation((name: string) => {
    if (name === "sign_video_approval") {
      signed = true;
      return Promise.resolve({ data: null, error: null });
    }
    return Promise.resolve({ data: {
      owner_user_id: "owner", manager_user_id: "smm", client_user_id: null,
      owner_approved: signed, manager_approved: true, client_approved: false,
      can_configure: false, current_user_id: "owner", client_accounts: [],
    }, error: null });
  });
  const finalApprove = vi.fn();
  render(<VideoApprovalRoute assetId="video-1" onFinalApprove={finalApprove} />);
  expect(await screen.findByRole("button", { name: "Sign as owner" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Final approve" })).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Sign as owner" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Final approve" })).toBeInTheDocument());
  await userEvent.setup().click(screen.getByRole("button", { name: "Final approve" }));
  expect(finalApprove).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledWith("sign_video_approval", { p_asset_id: "video-1", p_role: "owner" });
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
  render(<VideoApprovalRoute assetId="video-1" onFinalApprove={vi.fn()} />);
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
  render(<VideoApprovalRoute assetId="video-1" onFinalApprove={vi.fn()} />);
  expect(await screen.findByText(/request is in their dashboard; email not sent/i)).toBeInTheDocument();
  expect(rpc).toHaveBeenCalledWith("video_client_approval_email_state", { p_asset_id: "video-1" });
});
