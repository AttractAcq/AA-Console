import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { from, callRuntime } = vi.hoisted(() => ({ from: vi.fn(), callRuntime: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("../../lib/callRuntime", () => ({ callRuntime }));

import { DailyCodeVideoControls } from "./DailyCodeVideoControls";

beforeEach(() => { vi.clearAllMocks(); });

const ROUTE = "33333333-3333-4333-8333-333333333333";
const SOURCE = "44444444-4444-4444-8444-444444444444";

function query(data: unknown) {
  const chain = {
    select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
    maybeSingle: async () => ({ data, error: null }),
    then: (resolve: (result: { data: unknown; error: null }) => unknown) =>
      Promise.resolve({ data, error: null }).then(resolve),
  };
  return chain;
}

it("lets an operator save reviewed sources and explicitly request one code-video day", async () => {
  let saved = false;
  from.mockImplementation((table: string) => table === "client_daily_package_settings"
    ? query({ campaign_id: "c1", enabled: true, platform: "instagram", story_media_type: "image" })
    : table === "client_daily_video_sources_v1"
      ? query(saved ? { route_package_id: ROUTE, model_record_ids: [SOURCE] } : null)
      : table === "model_section_review_state_v7" ? query([
        { record_id: SOURCE, title: "Reviewed service", domain: "offer_strategy" },
      ]) : query([{ id: ROUTE, version: 2, route: "organic" }]));
  callRuntime.mockImplementation(async (_path: string, body: { action: string }) => {
    if (body.action === "configure") saved = true;
    return { ok: true, runId: "run-1", packageId: "package-1" };
  });
  const onPlanned = vi.fn();
  render(<DailyCodeVideoControls clientId="client-1" onPlanned={onPlanned} />);
  fireEvent.change(await screen.findByLabelText("Daily video organic route"), { target: { value: ROUTE } });
  fireEvent.click(screen.getByText(/Reviewed service/));
  fireEvent.click(screen.getByRole("button", { name: "Save daily video sources" }));
  await waitFor(() => expect(callRuntime).toHaveBeenCalledWith("/admin/video/daily", {
    action: "configure", clientId: "client-1", routePackageId: ROUTE,
    modelRecordIds: [SOURCE],
  }));
  fireEvent.change(screen.getByLabelText("Daily video package day"),
    { target: { value: "2099-01-02" } });
  fireEvent.click(screen.getByRole("button", { name: "Request code-video day" }));
  await waitFor(() => expect(callRuntime).toHaveBeenCalledWith("/admin/video/daily", {
    action: "plan", clientId: "client-1", packageDay: "2099-01-02",
  }));
  expect(onPlanned).toHaveBeenCalledOnce();
});

it("shows the disabled daily package prerequisite without submitting a day", async () => {
  from.mockImplementation((table: string) => table === "client_daily_package_settings"
    ? query({ campaign_id: "c1", enabled: false, platform: "instagram", story_media_type: "image" })
    : table === "client_daily_video_sources_v1"
      ? query({ route_package_id: ROUTE, model_record_ids: [SOURCE] })
      : table === "model_section_review_state_v7"
        ? query([{ record_id: SOURCE, title: "Reviewed service", domain: "offer_strategy" }])
        : query([{ id: ROUTE, version: 2, route: "organic" }]));
  render(<DailyCodeVideoControls clientId="client-1" onPlanned={vi.fn()} />);
  expect(await screen.findByText(/client daily package switch is off/i)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Daily video package day"),
    { target: { value: "2099-01-02" } });
  expect(screen.getByRole("button", { name: "Request code-video day" })).toBeDisabled();
  expect(callRuntime).not.toHaveBeenCalled();
});
