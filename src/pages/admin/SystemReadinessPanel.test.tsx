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
    publicPerimeter: { state: "observed", checkedAt: "2026-10-29T12:00:00Z", reason: null,
      value: { asOf: "2026-10-29T12:00:00Z", budgetDay: "2026-10-29",
        quotaLastHour: [{ route: "lead_submit", bucketKind: "ip", activeBuckets: 2, countedAttempts: 9 }],
        budgetsToday: [{ deploymentId: "deployment-1", messages: 3,
          committedUsd: 0.04, heldUsd: 0.02, uncertainCount: 1 }],
        unresolvedUncertain: 1,
      } },
    requestProxy: { directPeer: "10.0.0.2", forwardedHops: ["203.0.113.9", "10.0.0.3"],
      signedIngressRequired: false,
      chainStatus: "ignored_untrusted_peer", trustedProxyCount: 0,
      callerIpUsedForQuota: "10.0.0.2" },
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
  expect(screen.getByText("Public acquisition perimeter")).toBeInTheDocument();
  expect(screen.getByText("lead_submit")).toBeInTheDocument();
  expect(screen.getByText("deployment-1")).toBeInTheDocument();
  expect(screen.getByText(/Direct socket peer:/)).toBeInTheDocument();
  expect(screen.getByText(/ignored untrusted peer/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
  const [first, second] = await Promise.all(blobs.map((blob) => blob.text()));
  expect(first).toBe(second);
  expect(JSON.parse(first)).toMatchObject({
    capturedAt: "2026-10-29T12:00:00Z", environment: { name: "staging" },
    runtime: { sha }, browser: { capturedAt: "2026-10-29T12:00:00Z" },
  });
});
