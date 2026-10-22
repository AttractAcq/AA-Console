import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-1" }),
  Link: ({ to, children }: { to: string; children: unknown }) =>
    createElement("a", { href: to }, children as never),
}));

import { CampaignActionApprovalsPanel } from "./CampaignActionApprovalsPanel";

const pending = {
  id: "approval-1", client_id: "client-1", campaign_id: "campaign-1",
  manifest_id: "manifest-1", action_key: "meta_ad_build",
  destination: "meta:act_123", artifact_version_hash: "a".repeat(32),
  scope: { daily_spend_limit: 50 }, status: "pending",
};

/** One approved action and what became of it, as campaign_action_due reports. */
const done = {
  approval_id: "approval-0", client_id: "client-1", campaign_id: "campaign-1",
  action_key: "proof_publish", destination: "Third Party Directories",
  artifact_version_hash: "b".repeat(64), execution_id: "execution-1",
  execution_status: "executed", attempts: 1, external_id: "ext-99",
  external_url: "https://directory.test/listing/99", last_error: null,
  executor_module: "proof_distribution", blocker: "Already done.",
};

/**
 * The reads this panel makes, in the three shapes it makes them.
 *
 * `campaign_action_due` and the engine settings row are read without an
 * `order`, so the mock has to resolve on `eq` and `maybeSingle` as well —
 * otherwise the panel's own error path is what the test exercises.
 */
function database(
  options: {
    pending?: unknown[];
    due?: unknown[];
    actionsOn?: boolean;
    snapshots?: unknown[];
  } = {},
) {
  let records = options.pending ?? [pending];
  from.mockImplementation((table: string) => {
    if (table === "campaign_action_due") {
      const query = {
        select: () => query,
        eq: async () => ({ data: options.due ?? [done], error: null }),
      };
      return query;
    }
    if (table === "client_engine_settings") {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: { campaign_actions_enabled: options.actionsOn ?? false },
          error: null,
        }),
      };
      return query;
    }
    if (table === "campaign_page_approval_snapshots") {
      return { select: () => ({ in: async () => ({ data: options.snapshots ?? [], error: null }) }) };
    }
    const query = {
      select: () => query,
      eq: () => query,
      order: () => Promise.resolve({ data: records, error: null }),
    };
    return query;
  });
  rpc.mockImplementation(async (name: string) => {
    if (name === "decide_campaign_action_approval_v6") records = [];
    return { error: null };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  database();
});

it("shows the exact destination and scope before a human approves", async () => {
  const user = userEvent.setup();
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText("meta:act_123", { exact: false })).toBeInTheDocument();
  expect(screen.getByText(/daily_spend_limit/)).toBeInTheDocument();
  expect(screen.getByText("a".repeat(32))).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Approve this scope" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_campaign_action_approval_v6", {
    // An approval carries no reason: the key is left out so the function's
    // own default applies, which is the same null it used to be sent.
    p_request_id: "approval-1", p_decision: "approved",
  }));
  expect(await screen.findByText("No campaign action requests are waiting.")).toBeInTheDocument();
});

it("requires the frozen page HTML before allowing page deployment approval", async () => {
  const pageRequest = { ...pending, action_key: "page_deploy",
    destination: "https://sites.example/offer/" };
  database({
    pending: [pageRequest],
    snapshots: [{ approval_id: "approval-1", rendered_html: "<html><body>Exact offer</body></html>" }],
  });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByTitle("Page revision for https://sites.example/offer/"))
    .toHaveAttribute("sandbox", "");
  expect(screen.getByText(/Exact offer/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approve this scope" })).toBeEnabled();
});

it("refuses a page approval with no reviewable snapshot", async () => {
  database({ pending: [{ ...pending, action_key: "page_deploy" }], snapshots: [] });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText(/No reviewable page snapshot is attached/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approve this scope" })).toBeDisabled();
});

it("says what became of an action after it was approved", async () => {
  render(<CampaignActionApprovalsPanel />);
  // The state, who performs it, and the external record. An approval whose
  // outcome nobody can see is the same problem as no approval at all.
  expect(await screen.findByText("After the decision")).toBeInTheDocument();
  expect(screen.getByText("proof publish")).toBeInTheDocument();
  expect(screen.getByText(/performed by proof distribution/)).toBeInTheDocument();
  expect(screen.getByText("Already done.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "ext-99" })).toHaveAttribute(
    "href",
    "https://directory.test/listing/99",
  );
});

it("shows the reason an approved action has not happened, and does not call it done", async () => {
  database({
    due: [{
      ...done, execution_status: "not_attempted", attempts: 0, execution_id: null,
      external_id: null, external_url: null,
      blocker: "External campaign actions are off for this client.",
    }],
  });
  render(<CampaignActionApprovalsPanel />);
  expect(
    await screen.findByText("External campaign actions are off for this client."),
  ).toBeInTheDocument();
  expect(screen.getByText(/Nothing has tried to perform it yet/)).toBeInTheDocument();
});

it("keeps the client switch separate from any one approval", async () => {
  const user = userEvent.setup();
  render(<CampaignActionApprovalsPanel />);
  expect(
    await screen.findByText("External campaign actions are off for this client"),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Turn on" }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("set_campaign_actions_enabled", {
      p_client_id: "client-1",
      p_enabled: true,
    }),
  );
});

it("reports a failed attempt's error rather than leaving it blank", async () => {
  database({
    due: [{
      ...done, execution_status: "abandoned", attempts: 2, external_id: null,
      external_url: null, last_error: "Google Business Profile refused the post (403): no access",
      blocker: "Abandoned after a failure that cannot be safely retried: no access.",
    }],
  });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText(/refused the post \(403\)/)).toBeInTheDocument();
  expect(screen.getByText(/2 attempts/)).toBeInTheDocument();
});
