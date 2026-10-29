import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { readRuntime } = vi.hoisted(() => ({ readRuntime: vi.fn() }));
vi.mock("../../lib/readRuntime", () => ({ readRuntime }));
import { SystemReadinessPanel } from "./SystemReadinessPanel";

beforeEach(() => readRuntime.mockReset());

it("shows unknown deployment and external proof as unknown, even with a reachable runtime", async () => {
  readRuntime.mockResolvedValue({
    schemaVersion: 1, capturedAt: "2026-10-29T12:00:00Z",
    environment: { name: "production", railwayEnvironmentId: null, supabaseProjectRef: "project" },
    runtime: { sha: null, switches: { workers: true, publishing: false },
      credentialPresence: { anthropic: true },
      heartbeats: { state: "unknown", checkedAt: "2026-10-29T12:00:00Z", value: null,
        reason: "No runtime heartbeat has been recorded." } },
    gateway: { state: "unknown", checkedAt: "2026-10-29T12:00:00Z", value: null,
      reason: "Gateway URL or service credential is not configured for a probe." },
    database: { state: "error", checkedAt: "2026-10-29T12:00:00Z", value: null,
      reason: "Schema catalog could not be read." },
    global: { state: "unknown", checkedAt: "2026-10-29T12:00:00Z", value: null,
      reason: "Global configuration is unavailable." },
    clients: { state: "observed", checkedAt: "2026-10-29T12:00:00Z", value: [], reason: null },
  });
  render(<SystemReadinessPanel />);
  expect(await screen.findByText("Runtime deployed commit")).toBeInTheDocument();
  expect(screen.getByText(/No runtime heartbeat has been recorded/)).toBeInTheDocument();
  expect(screen.getByText(/Schema catalog could not be read/)).toBeInTheDocument();
  expect(screen.getByText(/Provider receipts, read-back, actual spend/)).toBeInTheDocument();
  expect(screen.queryByText("Runtime healthy")).not.toBeInTheDocument();
  expect(readRuntime).toHaveBeenCalledWith("/admin/system-readiness");
});

it("exports the same captured facts shown in the admin view on repeated downloads", async () => {
  const sha = "a".repeat(40);
  readRuntime.mockResolvedValue({
    schemaVersion: 1, capturedAt: "2026-10-29T12:00:00Z",
    environment: { name: "staging", railwayEnvironmentId: "railway-stage", supabaseProjectRef: "stage-project" },
    runtime: { sha, switches: { workers: true }, credentialPresence: { anthropic: true },
      heartbeats: { state: "observed", checkedAt: "2026-10-29T12:00:00Z", value: [], reason: null } },
    gateway: { state: "unknown", checkedAt: "2026-10-29T12:00:00Z", value: null, reason: "No probe." },
    database: { state: "error", checkedAt: "2026-10-29T12:00:00Z", value: null, reason: "No catalog." },
    global: { state: "observed", checkedAt: "2026-10-29T12:00:00Z",
      value: { engineEnabled: false, publishingPlatforms: [], proofDestinations: [],
        campaignActionExecutors: [{ key: "google_ad_build", module: "google_ads_studio", supported: false }],
        messageChannels: [{ key: "email", transport: "resend", supported: true, canInitiate: true }],
      }, reason: null },
    clients: { state: "observed", checkedAt: "2026-10-29T12:00:00Z", value: [], reason: null },
  });
  const blobs: Blob[] = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (blob: Blob) => {
    blobs.push(blob); return "blob:readiness";
  } });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<SystemReadinessPanel />);
  expect(await screen.findByRole("link", { name: sha })).toBeInTheDocument();
  expect(screen.getByText(/Environment staging/)).toBeInTheDocument();
  expect(screen.getByText(/google_ad_build unsupported/)).toBeInTheDocument();
  expect(screen.getByText(/email supported, can initiate/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
  const [first, second] = await Promise.all(blobs.map((blob) => blob.text()));
  expect(first).toBe(second);
  expect(JSON.parse(first)).toMatchObject({
    capturedAt: "2026-10-29T12:00:00Z", environment: { name: "staging" },
    runtime: { sha }, browser: { capturedAt: "2026-10-29T12:00:00Z" },
  });
});
