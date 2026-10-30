import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const RETIRED = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "44444444-4444-4444-8444-444444444444";
const REQUEST = "55555555-5555-4555-8555-555555555555";

const state = vi.hoisted(() => ({
  profile: { id: "admin-1", role: "admin" },
  members: [] as Array<Record<string, unknown>>,
  requests: [] as Array<Record<string, unknown>>,
  requestError: null as string | null,
}));
const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock("../../context/auth", () => ({ useAuth: () => ({ profile: state.profile }) }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));

import { SalesAccessRequestsPanel } from "./SalesAccessRequestsPanel";

function query(table: string) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => table === "team_members"
      ? Promise.resolve({ data: state.members, error: null }) : chain),
    limit: vi.fn(() => Promise.resolve({
      data: state.requests,
      error: state.requestError ? { message: state.requestError } : null,
    })),
  };
  return chain;
}

function show() {
  return render(<MemoryRouter initialEntries={[`/clients/${CLIENT}/delivery/sales-os?tab=leads`]}>
    <Routes><Route path="/clients/:clientId/delivery/sales-os" element={<SalesAccessRequestsPanel />} /></Routes>
  </MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.profile = { id: "admin-1", role: "admin" };
  state.members = [
    { id: MEMBER, name: "Pat Sales", active: true, user_id: ACCOUNT, profiles: { role: "employee" } },
    { id: RETIRED, name: "Former Sales", active: false, user_id: null, profiles: null },
    { id: "66666666-6666-4666-8666-666666666666", name: "Unlinked", active: true, user_id: null, profiles: null },
    { id: "77777777-7777-4777-8777-777777777777", name: "Client Account", active: true,
      user_id: "88888888-8888-4888-8888-888888888888", profiles: { role: "client" } },
  ];
  state.requests = [];
  state.requestError = null;
  from.mockImplementation(query);
  rpc.mockResolvedValue({ data: REQUEST, error: null });
});

describe("admin sales access source requests", () => {
  it("requests the exact route client/member/action via the owning RPC and links its Inbox card", async () => {
    show();
    const picker = await screen.findByLabelText("Team member");
    expect(screen.getByRole("option", { name: /Pat Sales/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Former Sales/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Unlinked/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Client Account/ })).not.toBeInTheDocument();
    await userEvent.selectOptions(picker, MEMBER);
    expect(screen.getByText(new RegExp(`Current linked employee account: ${ACCOUNT}`))).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Request sales access grant" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("request_client_sales_entitlement", {
      p_client_id: CLIENT, p_member_id: MEMBER, p_action: "grant",
    }));
    expect(await screen.findByRole("link", { name: /Review its exact version/ }))
      .toHaveAttribute("href", `/approvals?source=${REQUEST}`);
    expect(from).not.toHaveBeenCalledWith("client_sales_entitlements");
    expect(from).not.toHaveBeenCalledWith("client_sales_entitlement_controls");
    expect(screen.getByText(/Request history is not proof of current access/)).toBeInTheDocument();
  });

  it("keeps a pending duplicate in the Inbox and never submits another request", async () => {
    state.requests = [{ id: REQUEST, client_id: CLIENT, member_id: MEMBER, bound_user_id: ACCOUNT,
      action: "grant", scope_hash: "a".repeat(64), status: "pending", requested_at: "2026-10-30T00:00:00Z",
      member_name_snapshot: "Pat Sales" }];
    show();
    await userEvent.selectOptions(await screen.findByLabelText("Team member"), MEMBER);
    expect(screen.getByRole("button", { name: "Request sales access grant" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Review it in the Inbox" }))
      .toHaveAttribute("href", `/approvals?source=${REQUEST}`);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("allows a retired or relinked member to request revocation, leaving grant proof to the database", async () => {
    show();
    await screen.findByLabelText("Team member");
    await userEvent.selectOptions(screen.getByLabelText("Action"), "revoke");
    await userEvent.selectOptions(screen.getByLabelText("Team member"), RETIRED);
    expect(screen.getByText(/database will verify a current grant against its original bound account/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Request sales access revoke" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("request_client_sales_entitlement", {
      p_client_id: CLIENT, p_member_id: RETIRED, p_action: "revoke",
    }));
    expect(screen.getByText(/A pending revoke does not suspend an approved grant/)).toBeInTheDocument();
  });

  it("reports backend duplicate or missing-grant errors without claiming a new request", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "This member has no current sales grant for this client." } });
    show();
    await screen.findByLabelText("Team member");
    await userEvent.selectOptions(screen.getByLabelText("Action"), "revoke");
    await userEvent.selectOptions(screen.getByLabelText("Team member"), RETIRED);
    await userEvent.click(screen.getByRole("button", { name: "Request sales access revoke" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no current sales grant");
    expect(screen.queryByRole("link", { name: /Review its exact version/ })).not.toBeInTheDocument();
  });

  it("fails closed on source-read failure and on a non-admin profile", async () => {
    state.requestError = "Read denied";
    const view = show();
    expect(await screen.findByRole("alert")).toHaveTextContent("Read denied");
    expect(screen.queryByRole("button", { name: /Request sales access grant/ })).not.toBeInTheDocument();
    view.unmount();
    vi.clearAllMocks();
    state.profile = { id: "employee-1", role: "employee" };
    show();
    expect(screen.queryByText("Sales access requests")).not.toBeInTheDocument();
    expect(from).not.toHaveBeenCalled();
  });
});
