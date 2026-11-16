import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../config.js";
import { reconcileUncertainPage } from "./page-reconciler.js";

const { resolveInstallation, mintInstallationToken, readRepoFile } = vi.hoisted(() => ({
  resolveInstallation: vi.fn(), mintInstallationToken: vi.fn(), readRepoFile: vi.fn(),
}));
vi.mock("../../github/app-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../github/app-auth.js")>(),
  resolveInstallation, mintInstallationToken,
}));
vi.mock("../../github/repos.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../github/repos.js")>(), readRepoFile,
}));

const target = { execution_id: "execution-1", client_id: "client-1",
  repository_owner: "AttractAcq-Sites", repository_name: "client-site",
  site_path: "offer/index.html", checked_ref: "main",
  expected_sha256: "a".repeat(64), expected_kind: "reviewed_html" };
const config = { githubAppId: "123", githubAppPrivateKey: "key",
  githubInstallationId: "456" } as RuntimeConfig;

beforeEach(() => {
  vi.clearAllMocks();
  resolveInstallation.mockResolvedValue({ account: "AttractAcq-Sites", installationId: 456 });
  mintInstallationToken.mockResolvedValue({ token: "short-lived" });
  readRepoFile.mockResolvedValue({ sha256: "a".repeat(64), blobSha: "b".repeat(40) });
});

it("reads one frozen GitHub path and records the observation without publishing", async () => {
  const rpc = vi.fn(async (name: string) => name === "campaign_page_readback_target_v6"
    ? { data: target, error: null } : { data: "matches_expected", error: null });
  const result = await reconcileUncertainPage({ rpc } as unknown as SupabaseClient,
    config, "execution-1", "client-1");
  expect(result).toEqual({ status: "matches_expected" });
  expect(readRepoFile).toHaveBeenCalledWith("short-lived", "AttractAcq-Sites",
    "client-site", "offer/index.html", "main", expect.any(Function));
  expect(rpc).toHaveBeenCalledWith("record_campaign_page_readback_v6",
    expect.objectContaining({ p_execution_id: "execution-1", p_observed_sha256: "a".repeat(64) }));
});

it("holds a cross-client target or different installation owner", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: { ...target, client_id: "other" }, error: null });
  expect(await reconcileUncertainPage({ rpc } as unknown as SupabaseClient,
    config, "execution-1", "client-1")).toMatchObject({ status: "held" });
  expect(readRepoFile).not.toHaveBeenCalled();

  rpc.mockResolvedValue({ data: target, error: null });
  resolveInstallation.mockResolvedValue({ account: "SomeoneElse", installationId: 456 });
  expect(await reconcileUncertainPage({ rpc } as unknown as SupabaseClient,
    config, "execution-1", "client-1")).toMatchObject({ status: "held" });
  expect(mintInstallationToken).not.toHaveBeenCalled();
});

it("records a missing file as missing rather than a successful publish", async () => {
  readRepoFile.mockResolvedValue(null);
  const rpc = vi.fn(async (name: string) => name === "campaign_page_readback_target_v6"
    ? { data: target, error: null } : { data: "missing", error: null });
  expect(await reconcileUncertainPage({ rpc } as unknown as SupabaseClient,
    config, "execution-1", "client-1")).toEqual({ status: "missing" });
  expect(rpc).toHaveBeenCalledWith("record_campaign_page_readback_v6",
    expect.objectContaining({ p_observed_sha256: null }));
});
