import { beforeEach, describe, expect, it, vi } from "vitest";

import { runGoogleAdsSheetJob } from "./index.js";

vi.mock("../../queue.js", () => ({ appendEvent: vi.fn(async () => undefined) }));

const CLIENT = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "66666666-6666-4666-8666-666666666666";
const MANIFEST = "77777777-7777-4777-8777-777777777777";

function query(result: { data: unknown; error: { message: string } | null }) {
  const q = {
    select: () => q,
    eq: () => q,
    order: () => q,
    limit: () => q,
    maybeSingle: async () => result,
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  };
  return q;
}

function database(options: {
  manifest?: Record<string, unknown> | null;
  rpcError?: string;
} = {}) {
  const manifest = options.manifest === undefined
    ? { id: MANIFEST, client_id: CLIENT, acquisition_mode: "paid", paid_platform: "google" }
    : options.manifest;
  const from = vi.fn((table: string) => {
    switch (table) {
      case "campaign_manifest_versions":
        return query({ data: manifest, error: null });
      case "client_campaigns":
        return query({
          data: {
            id: CAMPAIGN, client_id: CLIENT, name: "Local service search",
            objective: "Book surveys", audience: null, daily_budget: 40,
            target_countries: ["Portsmouth"], conversion_event: "survey_booked",
            offer_version_id: null, acquisition_mode: "paid", paid_platform: "google",
          },
          error: null,
        });
      case "campaign_content_pillars":
      case "campaign_artifacts":
        return query({ data: table === "campaign_artifacts" ? null : [], error: null });
      default:
        throw new Error(`Unexpected table ${table}`);
    }
  });
  const rpc = vi.fn(async () => options.rpcError
    ? { data: null, error: { message: options.rpcError } }
    : { data: "sheet-1", error: null });
  return { from, rpc };
}

const job = {
  id: "job-1", client_id: CLIENT, input_table: "client_campaigns", input_id: CAMPAIGN,
};

beforeEach(() => vi.clearAllMocks());

describe("Google Ads sheet job manifest capture", () => {
  it("passes the captured manifest identity to the recording RPC", async () => {
    const sb = database();
    const result = await runGoogleAdsSheetJob(sb as never, {} as never, {} as never, job as never);
    expect(result.ok).toBe(true);
    expect(sb.from.mock.calls[0]).toEqual(["campaign_manifest_versions"]);
    expect(sb.rpc).toHaveBeenCalledWith(
      "record_google_ads_sheet_for_manifest_v6",
      expect.objectContaining({
        p_campaign_id: CAMPAIGN,
        p_manifest_id: MANIFEST,
        p_missing: expect.arrayContaining(["keyword_research"]),
      }),
    );
  });

  it("refuses derivation when there is no package to bind", async () => {
    const sb = database({ manifest: null });
    const result = await runGoogleAdsSheetJob(sb as never, {} as never, {} as never, job as never);
    expect(result.ok).toBe(false);
    expect(result.failureMessage).toContain("no package");
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it("surfaces a package supersession rejected at record time", async () => {
    const sb = database({ rpcError: "The campaign package changed during sheet derivation." });
    await expect(runGoogleAdsSheetJob(sb as never, {} as never, {} as never, job as never))
      .rejects.toThrow("package changed during sheet derivation");
    expect(sb.rpc).toHaveBeenCalledWith(
      "record_google_ads_sheet_for_manifest_v6",
      expect.objectContaining({ p_manifest_id: MANIFEST }),
    );
  });
});
