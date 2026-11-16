import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const { from, rpc, download } = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), download: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("../../lib/leadMagnets", () => ({ downloadVerifiedMagnetFile: download }));
import { CampaignPackageReadiness } from "./CampaignPackageReadiness";

const magnetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const versionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const hash = "a".repeat(64);

function query(data: unknown) {
  const q = {
    select: () => q, eq: () => q, in: () => Promise.resolve({ data, error: null }),
    order: () => q, limit: () => q,
    maybeSingle: () => Promise.resolve({ data, error: null }),
  };
  return q;
}

beforeEach(() => { from.mockReset(); rpc.mockReset(); download.mockReset(); });

it("links and verifies the exact magnet PDF in a frozen preparation package", async () => {
  const snapshot = { outputs: [{ item_key: "campaign_lead_magnet", route_key: "shared",
    output_fingerprint: hash, output_refs: [{ kind: "magnet_version", record_id: versionId,
      version: hash }] }] };
  from.mockImplementation((table: string) => table === "campaign_preparation_packages_v7"
    ? query({ id: "package-1", version: 1, snapshot_hash: hash,
      assembled_at: "2026-11-16T00:00:00Z", snapshot })
    : table === "lead_magnet_versions"
      ? query([{ id: versionId, magnet_id: magnetId, storage_path: "client/magnet.pdf",
        content_sha256: hash, file_bytes: 1234 }]) : query(null));
  rpc.mockImplementation((name: string) => Promise.resolve({ data:
    name === "campaign_package_readiness_v7"
      ? { status: "ready_for_review", blockers: [], expected: 1, ready: 1 }
      : true, error: null }));
  download.mockResolvedValue(undefined);
  render(<CampaignPackageReadiness campaignId="campaign-1" clientId="client-1" />);
  const link = await screen.findByRole("link", { name: "Open magnet" });
  expect(link).toHaveAttribute("href",
    `/clients/client-1/delivery/lead-magnet-studio?magnet=${magnetId}`);
  await userEvent.click(screen.getByRole("button", { name: "Download verified PDF" }));
  await waitFor(() => expect(download).toHaveBeenCalledWith("client/magnet.pdf", hash, 1234));
});

it("does not offer a file when the frozen output hash and version disagree", async () => {
  const snapshot = { outputs: [{ item_key: "campaign_lead_magnet", route_key: "shared",
    output_fingerprint: hash, output_refs: [{ kind: "magnet_version", record_id: versionId,
      version: hash }] }] };
  from.mockImplementation((table: string) => table === "campaign_preparation_packages_v7"
    ? query({ id: "package-1", version: 1, snapshot_hash: hash,
      assembled_at: "2026-11-16T00:00:00Z", snapshot })
    : table === "lead_magnet_versions"
      ? query([{ id: versionId, magnet_id: magnetId, storage_path: "client/magnet.pdf",
        content_sha256: "b".repeat(64), file_bytes: 1234 }]) : query(null));
  rpc.mockImplementation((name: string) => Promise.resolve({ data:
    name === "campaign_package_readiness_v7"
      ? { status: "ready_for_review", blockers: [], expected: 1, ready: 1 }
      : true, error: null }));
  render(<CampaignPackageReadiness campaignId="campaign-1" clientId="client-1" />);
  expect(await screen.findByText("Exact magnet file unavailable")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Download verified PDF" })).not.toBeInTheDocument();
});
