import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { from, callRuntime } = vi.hoisted(() => ({ from: vi.fn(), callRuntime: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("../../lib/callRuntime", () => ({ callRuntime }));

import { DailyPackageSetupPanel } from "./DailyPackageSetupPanel";

const CAMPAIGN = "77777777-7777-4777-8777-777777777777";
const PILLAR = "88888888-8888-4888-8888-888888888888";

function query(data: unknown) {
  const chain = {
    select: () => chain, eq: () => chain, in: () => chain, is: () => chain,
    order: () => chain, limit: () => chain,
    maybeSingle: async () => ({ data, error: null }),
    then: (resolve: (value: { data: unknown; error: null }) => unknown) =>
      Promise.resolve({ data, error: null }).then(resolve),
  };
  return chain;
}

beforeEach(() => { vi.clearAllMocks(); });

it("creates only disabled daily inputs through the AAL2 runtime route", async () => {
  from.mockImplementation((table: string) => table === "client_daily_package_settings"
    ? query(null)
    : table === "client_campaigns" ? query([{ id: CAMPAIGN, name: "Built campaign",
      built_at: "2026-11-21T00:00:00Z", audience: "Local buyers",
      offer_summary: "Assessed service" }])
      : query([{ id: PILLAR, name: "Service explanations" }]));
  callRuntime.mockResolvedValue({ ok: true });
  render(<DailyPackageSetupPanel clientId="client-1" />);
  fireEvent.change(await screen.findByLabelText("Daily package campaign"),
    { target: { value: CAMPAIGN } });
  fireEvent.change(screen.getByLabelText("Daily package pillar"),
    { target: { value: PILLAR } });
  fireEvent.click(screen.getByRole("button", { name: "Save daily package inputs" }));
  await waitFor(() => expect(callRuntime).toHaveBeenCalledWith("/admin/video/daily", {
    action: "setup", clientId: "client-1", campaignId: CAMPAIGN,
    pillarId: PILLAR, platform: "instagram", storyMediaType: "image",
    approvalCutoff: "09:00",
  }));
  expect(await screen.findByText(/Production remains off/)).toBeInTheDocument();
});

it("does not retarget an enabled daily package", async () => {
  from.mockImplementation((table: string) => table === "client_daily_package_settings"
    ? query({ enabled: true, campaign_id: CAMPAIGN, pillar_id: PILLAR,
      platform: "instagram", story_media_type: "image", approval_cutoff: "09:00:00" })
    : table === "client_campaigns" ? query([{ id: CAMPAIGN, name: "Built campaign",
      built_at: "2026-11-21T00:00:00Z", audience: "Local buyers",
      offer_summary: "Assessed service" }])
      : query([{ id: PILLAR, name: "Service explanations" }]));
  render(<DailyPackageSetupPanel clientId="client-1" />);
  expect(await screen.findByText(/Switch daily production off/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save daily package inputs" })).toBeDisabled();
  expect(callRuntime).not.toHaveBeenCalled();
});
