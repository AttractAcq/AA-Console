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
  expect(screen.getByText(/has not supplied machine-readable evidence coverage/)).toBeInTheDocument();
  expect(screen.queryByText("Runtime healthy")).not.toBeInTheDocument();
  expect(readRuntime).toHaveBeenCalledWith("/admin/system-readiness");
});

it("exports the same captured facts shown in the admin view on repeated downloads", async () => {
  const sha = "a".repeat(40);
  readRuntime.mockResolvedValue({
    schemaVersion: 2, capturedAt: "2026-10-29T12:00:00Z",
    environment: { name: "staging", railwayEnvironmentId: "railway-stage", supabaseProjectRef: "stage-project" },
    runtime: { sha, switches: { workers: true }, credentialPresence: { anthropic: true },
      actionHolds: {
        profileFieldPatch: { state: "held", reason: "Exact Inbox gate is not connected." },
        genericCampaignActionClaim: {
          state: "held", reason: "The SQL claim lacks an atomic handler-ownership gate.",
        },
      },
      heartbeats: { state: "observed", checkedAt: "2026-10-29T12:00:00Z", value: [], reason: null } },
    gateway: { state: "observed", checkedAt: "2026-10-29T12:00:00Z",
      value: { sha, observedAt: "2026-10-29T12:00:00Z",
        configured: { aaInternalApi: true, botAuthMode: "dual" } }, reason: null },
    database: { state: "error", checkedAt: "2026-10-29T12:00:00Z", value: null, reason: "No catalog." },
    global: { state: "observed", checkedAt: "2026-10-29T12:00:00Z",
      value: { engineEnabled: false, publishingPlatforms: [], proofDestinations: [],
        campaignActionExecutors: [
          { key: "google_ad_build", module: "google_ads_studio", supported: false, handlerRegistered: false },
          { key: "meta_ad_build", module: "meta_ads_studio", supported: true, handlerRegistered: false },
        ],
        campaignActionHandlerParity: { state: "blocked", unhandledSupportedKeys: ["meta_ad_build"] },
        messageChannels: [{ key: "email", transport: "resend", supported: true, canInitiate: true }],
      }, reason: null },
    clients: { state: "observed", checkedAt: "2026-10-29T12:00:00Z", value: [{
      id: "client-1", name: "Acme", switches: {}, platforms: [], leadCaptureEndpoints: [],
      proofDestinations: [], salesAgentDeployments: [], integrations: [{
        provider: "meta", status: "connected", ingestEnabled: false, hasCredential: true,
        lastCheckedAt: null, tokenExpiresAt: null, accountIds: { adAccountId: "act_123" },
        providerHealth: { state: "unknown", checkedAt: "2026-10-29T12:00:00Z",
          evidenceAt: null, source: "client_integrations metadata", reason: "No live provider probe." },
      }],
    }], reason: null },
    evidenceCoverage: {
      runtimeWorkers: { state: "observed", checkedAt: "2026-10-29T12:00:00Z",
        evidenceAt: "2026-10-29T11:59:59Z", source: "agent_runtime_status", reason: null },
      providerAccountHealth: { state: "unknown", checkedAt: "2026-10-29T12:00:00Z",
        evidenceAt: null, source: "client_integrations metadata", reason: "No live provider account check." },
    },
  });
  const blobs: Blob[] = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (blob: Blob) => {
    blobs.push(blob); return "blob:readiness";
  } });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<SystemReadinessPanel />);
  expect(await screen.findAllByRole("link", { name: sha })).toHaveLength(2);
  expect(screen.getByText(/Environment staging/)).toBeInTheDocument();
  expect(screen.getByText(/google_ad_build database unsupported, no runtime handler/)).toBeInTheDocument();
  expect(screen.getByRole("alert", { name: "" }).textContent).toContain("meta_ad_build");
  expect(screen.getByText(/email supported, can initiate/)).toBeInTheDocument();
  expect(screen.getByText(/Gateway Bot auth mode: dual/)).toBeInTheDocument();
  expect(screen.getByText(/Dual mode can still admit legacy environment identities/)).toBeInTheDocument();
  expect(screen.getByText(/live provider health Unknown/)).toBeInTheDocument();
  expect(screen.getByText("Profile field PATCH")).toBeInTheDocument();
  expect(screen.getByText("Generic campaign action claims")).toBeInTheDocument();
  expect(screen.getAllByText("Held")).toHaveLength(2);
  expect(screen.getByText("The SQL claim lacks an atomic handler-ownership gate.")).toBeInTheDocument();
  expect(screen.getByText("Exact Inbox gate is not connected.")).toBeInTheDocument();
  expect(screen.getByText(/last recorded integration check Unknown/)).toBeInTheDocument();
  expect(screen.getByText("No live provider probe.")).toBeInTheDocument();
  expect(screen.getByText(/No live provider account check/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
  const [first, second] = await Promise.all(blobs.map((blob) => blob.text()));
  expect(first).toBe(second);
  expect(JSON.parse(first)).toMatchObject({
    capturedAt: "2026-10-29T12:00:00Z", environment: { name: "staging" },
    runtime: { sha, actionHolds: {
      profileFieldPatch: { state: "held" },
      genericCampaignActionClaim: { state: "held" },
    } },
    gateway: { value: { configured: { botAuthMode: "dual" } } },
    browser: { capturedAt: "2026-10-29T12:00:00Z" },
    evidenceCoverage: { providerAccountHealth: { state: "unknown" } },
  });
});
