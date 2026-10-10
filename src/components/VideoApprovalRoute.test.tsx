import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: { rpc, from: vi.fn() } }));
import { VideoApprovalRoute } from "./VideoApprovalRoute";

beforeEach(() => { rpc.mockReset(); });

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
