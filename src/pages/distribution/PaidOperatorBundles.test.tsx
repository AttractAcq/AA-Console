import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

import { PaidOperatorBundles } from "./PaidOperatorBundles";

const rpc = vi.fn();
const rows: Record<string, unknown[]> = {
  client_campaigns: [{ id: "campaign-1", name: "Local offer", paid_platform: "meta" }],
  campaign_preparation_packages_v7: [{ id: "package-1", campaign_id: "campaign-1",
    version: 1, assembled_at: "2026-11-16T00:00:00Z" }],
  paid_operator_bundles_v7: [],
  paid_operator_events_v7: [],
  paid_operator_metric_match_v7: [],
  paid_google_operator_account_match_v7: [],
  meta_operator_account_match_v7: [],
};

vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const result = () => Promise.resolve({ data: rows[table] ?? [], error: null });
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, order: () => chain, limit: result,
        then: (...args: Parameters<Promise<unknown>["then"]>) => result().then(...args),
      };
      return chain;
    },
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  rows.client_campaigns = [{ id: "campaign-1", name: "Local offer", paid_platform: "meta" }];
  rows.campaign_preparation_packages_v7 = [{ id: "package-1", campaign_id: "campaign-1",
    version: 1, assembled_at: "2026-11-16T00:00:00Z" }];
  rows.paid_operator_bundles_v7 = [];
  rows.paid_operator_events_v7 = [];
  rows.paid_operator_metric_match_v7 = [];
  rows.paid_google_operator_account_match_v7 = [];
  rows.meta_operator_account_match_v7 = [];
  rpc.mockResolvedValue({ data: true, error: null });
});

it("shows only the selected campaign's operator pack inside Campaign Factory", async () => {
  rows.client_campaigns = [
    { id: "campaign-1", name: "Selected campaign", paid_platform: "meta" },
    { id: "campaign-2", name: "Another client campaign", paid_platform: "meta" },
  ];
  rows.campaign_preparation_packages_v7 = [
    { id: "package-1", campaign_id: "campaign-1", version: 1, assembled_at: "2026-11-16T00:00:00Z" },
    { id: "package-2", campaign_id: "campaign-2", version: 1, assembled_at: "2026-11-17T00:00:00Z" },
  ];
  rows.paid_operator_bundles_v7 = [
    { id: "bundle-1", campaign_id: "campaign-1", platform: "meta", version: 1,
      snapshot_hash: "a".repeat(64), snapshot: { source: { campaign_name: "Selected campaign" } },
      created_at: "2026-11-16T00:00:00Z" },
    { id: "bundle-2", campaign_id: "campaign-2", platform: "meta", version: 1,
      snapshot_hash: "b".repeat(64), snapshot: { source: { campaign_name: "Another client campaign" } },
      created_at: "2026-11-17T00:00:00Z" },
  ];
  render(<PaidOperatorBundles clientId="client-1" platform="meta" campaignId="campaign-1" />);
  await screen.findByRole("option", { name: /Selected campaign · v1/ });
  expect(screen.queryByText(/Another client campaign/)).not.toBeInTheDocument();
  expect(screen.getByText(/Selected campaign · v1 · approved and current/)).toBeInTheDocument();
});

it("requires an exact reviewed package and operator instructions before freezing", async () => {
  render(<PaidOperatorBundles clientId="client-1" platform="meta" />);
  const freeze = screen.getByRole("button", { name: "Freeze operator bundle" });
  expect(freeze).toBeDisabled();
  await screen.findByRole("option", { name: /Local offer · v1/ });
  await userEvent.selectOptions(screen.getByLabelText("Reviewed campaign package"), "package-1");
  await userEvent.type(screen.getByLabelText("Paid operator"), "Paid manager");
  await userEvent.type(screen.getByLabelText("Budget instruction"), "Cap at 25 per day");
  await userEvent.type(screen.getByLabelText("Tracking instruction"), "Record campaign ID");
  await userEvent.click(freeze);
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("create_paid_operator_bundle_v7", {
    p_package_id: "package-1", p_owner: "Paid manager",
    p_budget_instruction: "Cap at 25 per day", p_tracking_instruction: "Record campaign ID",
  }));
});

it("requires a Google keyword research task in the exact operator packet", async () => {
  rows.client_campaigns = [{ id: "campaign-1", name: "Local offer", paid_platform: "google" }];
  render(<PaidOperatorBundles clientId="client-1" platform="google" />);
  const freeze = screen.getByRole("button", { name: "Freeze operator bundle" });
  await screen.findByRole("option", { name: /Local offer · v1/ });
  await userEvent.selectOptions(screen.getByLabelText("Reviewed campaign package"), "package-1");
  await userEvent.type(screen.getByLabelText("Paid operator"), "Paid manager");
  await userEvent.type(screen.getByLabelText("Budget instruction"), "Cap at 25 per day");
  await userEvent.type(screen.getByLabelText("Tracking instruction"), "Record campaign ID");
  expect(freeze).toBeDisabled();
  await userEvent.type(screen.getByLabelText("Keyword research task"),
    "Research search terms, match types and negatives before launch");
  await userEvent.click(freeze);
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("create_google_paid_operator_bundle_v7", {
    p_package_id: "package-1", p_owner: "Paid manager",
    p_budget_instruction: "Cap at 25 per day", p_tracking_instruction: "Record campaign ID",
    p_research_task: "Research search terms, match types and negatives before launch",
  }));
});

it("keeps a stale bundle from reporting a handoff", async () => {
  rows.paid_operator_bundles_v7 = [{ id: "bundle-1", client_id: "client-1",
    campaign_id: "campaign-1", package_id: "package-1", platform: "meta", version: 1,
    snapshot_hash: "a".repeat(64), snapshot: { source: { campaign_name: "Local offer" } },
    created_at: "2026-11-16T00:00:00Z", created_by: "user-1" }];
  rpc.mockResolvedValue({ data: false, error: null });
  render(<PaidOperatorBundles clientId="client-1" platform="meta" />);
  expect(await screen.findByText(/Local offer · v1 · stale or unverified/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Report handoff" })).toBeDisabled();
});

it("requires a reported verified download before the handoff button is usable", async () => {
  rows.paid_operator_bundles_v7 = [{ id: "bundle-1", client_id: "client-1",
    campaign_id: "campaign-1", package_id: "package-1", platform: "meta", version: 1,
    snapshot_hash: "a".repeat(64), snapshot: { source: { campaign_name: "Local offer" } },
    created_at: "2026-11-16T00:00:00Z", created_by: "user-1" }];
  render(<PaidOperatorBundles clientId="client-1" platform="meta" />);
  expect(await screen.findByText(/Local offer · v1 · approved and current/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Report handoff" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Download and verify all files" })).toBeEnabled();
});

it("shows the reviewed Google copy packet without requiring a media file", async () => {
  rows.client_campaigns = [{ id: "campaign-1", name: "Local offer", paid_platform: "google" }];
  rows.paid_operator_bundles_v7 = [{ id: "bundle-google", client_id: "client-1",
    campaign_id: "campaign-1", package_id: "package-1", platform: "google", version: 1,
    snapshot_hash: "b".repeat(64), snapshot: { source: { campaign_name: "Local offer",
      creative: [{ copy_id: "copy-1", copy_hash: "c".repeat(64),
        headlines: ["Book a consultation"], descriptions: ["Speak with our team"] }] } },
    created_at: "2026-11-16T00:00:00Z", created_by: "user-1" }];
  rows.paid_google_operator_account_match_v7 = [{ bundle_id: "bundle-google",
    match_state: "provider_campaign_observed_metrics_unknown",
    configured_customer_id: "1234567890", read_run_id: "read-1",
    provider_request_id: "request-1", latest_fetched_at: "2026-11-16T01:00:00Z" }];
  render(<PaidOperatorBundles clientId="client-1" platform="google" />);
  expect(await screen.findByText(/Local offer · v1 · approved and current/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download and verify Google packet" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: /Download verified/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Report handoff" })).toBeDisabled();
  expect(screen.getByText(/period metrics unknown/)).toBeInTheDocument();
  expect(screen.getByText(/Customer 1234567890 · read read-1/)).toBeInTheDocument();
});

it("holds exact packet download and handoff until the bundle review is approved", async () => {
  rows.paid_operator_bundles_v7 = [{ id: "bundle-1", client_id: "client-1",
    campaign_id: "campaign-1", package_id: "package-1", platform: "meta", version: 1,
    snapshot_hash: "a".repeat(64), snapshot: { source: { campaign_name: "Local offer" } },
    created_at: "2026-11-16T00:00:00Z", created_by: "user-1" }];
  rpc.mockImplementation((name: string) => Promise.resolve({
    data: name === "paid_operator_bundle_approved_v7" ? false : true, error: null,
  }));
  render(<PaidOperatorBundles clientId="client-1" platform="meta" />);
  expect(await screen.findByText(/Local offer · v1 · not approved/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download exact JSON" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Download and verify all files" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Report handoff" })).toBeDisabled();
});

it("shows a metric row match without calling it provider verification", async () => {
  rows.paid_operator_bundles_v7 = [{ id: "bundle-1", client_id: "client-1",
    campaign_id: "campaign-1", package_id: "package-1", platform: "meta", version: 1,
    snapshot_hash: "a".repeat(64), snapshot: { source: { campaign_name: "Local offer" } },
    created_at: "2026-11-16T00:00:00Z", created_by: "user-1" }];
  rows.paid_operator_metric_match_v7 = [{ bundle_id: "bundle-1",
    match_state: "metric_rows_match_reported_id", days_with_rows: 2,
    latest_metric_date: "2026-11-16", latest_fetched_at: "2026-11-16T01:00:00Z",
    recorded_spend: 20, currency: "USD", currencies_seen: 1,
    recorded_impressions: 100, recorded_clicks: 5, recorded_conversions: null }];
  render(<PaidOperatorBundles clientId="client-1" platform="meta" />);
  expect(await screen.findByText(/2 daily row\(s\)/)).toBeInTheDocument();
  expect(screen.getByText(/Recorded spend 20 USD/)).toBeInTheDocument();
  expect(screen.getByText(/does not verify provider account identity/)).toBeInTheDocument();
  expect(screen.getByText(/Configured Meta account read: Unknown/)).toBeInTheDocument();
});

it("separates a Meta account observation from the generic metric rows", async () => {
  rows.paid_operator_bundles_v7 = [{ id: "bundle-1", client_id: "client-1",
    campaign_id: "campaign-1", package_id: "package-1", platform: "meta", version: 1,
    snapshot_hash: "a".repeat(64), snapshot: { source: { campaign_name: "Local offer" } },
    created_at: "2026-11-16T00:00:00Z", created_by: "user-1" }];
  rows.meta_operator_account_match_v7 = [{ bundle_id: "bundle-1",
    match_state: "observed_in_meta_account", reported_campaign_id: "campaign-meta-1",
    reported_ad_id: "ad-meta-1", configured_account_id: "act_123", read_run_id: "read-1",
    fetched_at: "2026-11-16T01:00:00Z", observed_campaign_status: "ACTIVE",
    observed_ad_status: "ACTIVE" }];
  render(<PaidOperatorBundles clientId="client-1" platform="meta" />);
  expect(await screen.findByText(/Reported campaign and ad observed in the configured account/)).toBeInTheDocument();
  expect(screen.getByText(/Account act_123 · read read-1/)).toBeInTheDocument();
  expect(screen.getByText(/does not prove who activated the ad/)).toBeInTheDocument();
  expect(screen.getByText(/Metrics match: Unknown/)).toBeInTheDocument();
});
