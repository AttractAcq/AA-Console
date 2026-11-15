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
    attempts?: unknown[];
    revocations?: unknown[];
    readbacks?: unknown[];
    budgetJobs?: unknown[];
    pageReadbacks?: unknown[];
    pageJobs?: unknown[];
    proofRows?: unknown[];
    leadRows?: unknown[];
    runtime?: unknown;
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
    if (table === "campaign_action_attempts_v6") {
      const query = { in: () => query,
        order: async () => ({ data: options.attempts ?? [], error: null }) };
      return { select: () => query };
    }
    if (table === "campaign_budget_readback_overview_v6") {
      const query = { in: () => query,
        order: async () => ({ data: options.readbacks ?? [], error: null }) };
      return { select: () => query };
    }
    if (table === "campaign_page_readback_overview_v6") {
      const query = { in: () => query,
        order: async () => ({ data: options.pageReadbacks ?? [], error: null }) };
      return { select: () => query };
    }
    if (table === "campaign_proof_release_observations_v6") {
      return { select: () => ({ in: async () => ({ data: options.proofRows ?? [], error: null }) }) };
    }
    if (table === "campaign_lead_enrolment_source_v6") {
      return { select: () => ({ in: async () => ({ data: options.leadRows ?? [], error: null }) }) };
    }
    if (table === "agent_jobs") {
      let key = "";
      const query = { eq: (_column: string, value: string) => { key = value; return query; }, in: () => query,
        order: async () => ({ data: key === "campaign_page_reconciler"
          ? options.pageJobs ?? [] : options.budgetJobs ?? [], error: null }) };
      return { select: () => query };
    }
    if (table === "campaign_action_revocations_v6") {
      return { select: () => ({ in: async () => ({ data: options.revocations ?? [], error: null }) }) };
    }
    const query = {
      select: () => query,
      eq: () => query,
      order: () => Promise.resolve({ data: records, error: null }),
    };
    return query;
  });
  rpc.mockImplementation(async (name: string) => {
    if (name === "client_runtime_controls_v6") return { data: options.runtime ?? null, error: null };
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
  // The state, assigned module, and external record. An approval whose
  // outcome nobody can see is the same problem as no approval at all.
  expect(await screen.findByText("After the decision")).toBeInTheDocument();
  expect(screen.getByText("proof publish")).toBeInTheDocument();
  expect(screen.getByText(/Executor module: proof distribution/)).toBeInTheDocument();
  expect(screen.getByText("Already done.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "ext-99" })).toHaveAttribute(
    "href",
    "https://directory.test/listing/99",
  );
});

it("shows a failed attempt and the later provider receipt separately", async () => {
  database({ due: [{ ...done, attempts: 2 }], attempts: [
    { execution_id: "execution-1", attempt_number: 1, status: "failed",
      started_at: "2026-11-14T08:00:00Z", finished_at: "2026-11-14T08:01:00Z",
      external_id: null, external_url: null, error: "Provider timeout", legacy_inferred: false },
    { execution_id: "execution-1", attempt_number: 2, status: "executed",
      started_at: "2026-11-14T08:05:00Z", finished_at: "2026-11-14T08:06:00Z",
      external_id: "ext-99", external_url: "https://directory.test/listing/99",
      error: null, legacy_inferred: false },
  ] });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText("Execution attempts")).toBeInTheDocument();
  expect(screen.getByText(/Attempt 1: failed/)).toBeInTheDocument();
  expect(screen.getByText("Provider timeout")).toBeInTheDocument();
  expect(screen.getByText(/Attempt 2: executed/)).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "ext-99" })).toHaveLength(2);
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
  expect(screen.getByText(/Executor module: proof distribution/)).toBeInTheDocument();
  expect(screen.queryByText(/performed by/i)).not.toBeInTheDocument();
});

it("shows the generic hold and does not offer a switch-on action", async () => {
  render(<CampaignActionApprovalsPanel />);
  expect(
    await screen.findByText("External campaign actions are off for this client"),
  ).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/Runtime state has not been verified/);
  expect(screen.getByRole("link", { name: "View controls on Dashboard" })).toHaveAttribute("href", "/clients/client-1/delivery/dashboard");
  expect(rpc).not.toHaveBeenCalledWith("set_campaign_actions_enabled", expect.anything());
});

it("shows an already-on switch but keeps its control on Dashboard", async () => {
  database({ actionsOn: true });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText("External campaign actions are on for this client")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Turn off" })).not.toBeInTheDocument();
});

it("shows an observed attested worker separately from the client switch", async () => {
  database({ actionsOn: true, runtime: { state: "observed", workerEnabled: true,
    controls: { campaignActions: true }, holds: {} } });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText("External campaign actions are on for this client")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/owned campaign action worker is observed and attested/);
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
  expect(screen.getByRole("alert")).toHaveTextContent("1 failed, stopped or uncertain action; 0 approved actions held before an attempt.");
  expect(screen.getByRole("link", { name: "Review blockers and attempt receipts" }))
    .toHaveAttribute("href", "#campaign-action-outcomes");
});

it("alerts the owning queue when an approved action is held before execution", async () => {
  database({ due: [{ ...done, execution_status: "not_attempted", execution_id: null,
    blocker: "Client switch is off.", external_id: null, external_url: null }] });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText("Campaign action owner attention")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("0 failed, stopped or uncertain actions; 1 approved action held before an attempt.");
});

it("shows an uncertain external effect and blocks another attempt", async () => {
  database({ due: [{ ...done, execution_status: "uncertain", attempts: 1,
    last_error: "Provider effect may have happened", external_id: "provider-123",
    blocker: "Provider effect may have happened; inspect the destination before any new approval." }] });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText(/Provider effect may have happened; inspect the destination/))
    .toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("1 failed, stopped or uncertain action");
});

it("requests a read-only Meta budget check and labels a value match as observation", async () => {
  const user = userEvent.setup();
  database({ due: [{ ...done, action_key: "budget_change", execution_status: "uncertain",
    external_id: "23848", external_url: null,
    blocker: "Provider effect may have happened; inspect the ad set." }],
    readbacks: [{ execution_id: "execution-1", result: "matches_proposed",
      observed_currency: "USD", observed_daily_budget_minor: 7500,
      checked_at: "2026-11-15T12:00:00Z", account_id: "act_123" }] });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText(/Latest observation: matches proposed/)).toBeInTheDocument();
  expect(screen.getByText(/does not prove this action changed it/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Check current Meta budget" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("request_campaign_budget_readback_v6", {
    p_execution_id: "execution-1",
  }));
});

it("requests a read-only GitHub page check and keeps intake unverified", async () => {
  const user = userEvent.setup();
  database({ due: [{ ...done, action_key: "page_deploy", execution_status: "uncertain",
    external_id: null, external_url: null,
    blocker: "Provider effect may have happened; inspect the repository." }],
    pageReadbacks: [{ execution_id: "execution-1", result: "matches_expected",
      checked_ref: "main", observed_sha256: "a".repeat(64),
      checked_at: "2026-11-15T12:00:00Z", repository_owner: "Org",
      repository_name: "site", site_path: "offer/index.html" }] });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText(/Latest observation: matches expected/)).toBeInTheDocument();
  expect(screen.getByText(/do not prove the page is publicly available or that its form works/))
    .toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Check GitHub page bytes" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("request_campaign_page_readback_v6", {
    p_execution_id: "execution-1",
  }));
});

it("shows proof release and destination receipts as separate facts", async () => {
  database({ due: [{ ...done, execution_status: "uncertain", blocker: "Inspect the placement release." }],
    proofRows: [{ execution_id: "execution-1", placement_ref: "placement-1",
      expected_payload_hash: "a".repeat(64), placement_approval_status: "approved",
      placement_status: "queued", payload_matches: true,
      destination_key: "google_business_profile", external_id: null,
      external_url: null, retracted_at: null }] });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText("Proof release source check")).toBeInTheDocument();
  expect(screen.getByText(/approval approved · placement queued/)).toBeInTheDocument();
  expect(screen.getByText(/still needs its destination placement receipt/)).toBeInTheDocument();
});

it("shows a committed lead enrolment sweep without calling it a message send", async () => {
  database({ due: [{ ...done, action_key: "lead_message", destination: "nurture sequence",
    external_id: null, external_url: null }], leadRows: [{
      execution_id: "execution-1", sequence_name: "Guide follow-up",
      started_at: "2026-11-15T08:00:00Z", finished_at: "2026-11-15T08:00:01Z",
      observed_count: 2, skipped_count: 1, current_observation_rows: 2,
    }] });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText("Lead enrolment source check")).toBeInTheDocument();
  expect(screen.getByText(/2 enrolment rows observed, 1 lead skipped/)).toBeInTheDocument();
  expect(screen.getByText(/Enrolment does not itself send a message/)).toBeInTheDocument();
});

it("does not treat a missing lead source run as a safe retry", async () => {
  database({ due: [{ ...done, action_key: "lead_message", execution_status: "uncertain",
    destination: "nurture sequence", external_id: null, external_url: null }],
    leadRows: [{ execution_id: "execution-1", sequence_name: "Guide follow-up",
      started_at: null, finished_at: null, observed_count: null,
      skipped_count: null, current_observation_rows: 0 }] });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText(/No committed enrolment run is recorded/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
});

it("requires a reason and records a revocation through the owning RPC", async () => {
  const user = userEvent.setup();
  render(<CampaignActionApprovalsPanel />);
  const button = await screen.findByRole("button", { name: "Revoke future execution" });
  await user.click(button);
  expect(screen.getByRole("alert")).toHaveTextContent("Enter a reason before revoking");
  expect(rpc).not.toHaveBeenCalledWith("revoke_campaign_action_approval_v6", expect.anything());
  await user.type(screen.getByRole("textbox", { name: "Reason to revoke proof_publish" }), "Client withdrew approval");
  await user.click(button);
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("revoke_campaign_action_approval_v6", {
    p_approval_id: "approval-0", p_reason: "Client withdrew approval",
  }));
});

it("shows a revoked decision without offering a second revocation", async () => {
  database({ revocations: [{ approval_id: "approval-0", reason: "Client withdrew approval",
    revoked_at: "2026-11-14T09:00:00Z" }] });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText(/Revoked: Client withdrew approval/)).toBeInTheDocument();
  expect(screen.getByText(/external effect already recorded remains live/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Revoke future execution" })).not.toBeInTheDocument();
});
