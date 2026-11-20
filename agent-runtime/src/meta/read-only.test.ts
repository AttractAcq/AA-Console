import { describe, expect, it, vi } from "vitest";
import { readMetaAdsAccount } from "./read-only.js";

const credentials = { accountId: "act_123", accessToken: "token" };
const response = (data: unknown) => new Response(JSON.stringify(data));

function provider() {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response({ id: "act_123", account_id: "123", currency: "USD" }))
    .mockResolvedValueOnce(response({ data: [{ id: "42", name: "Leads", status: "ACTIVE", effective_status: "ACTIVE" }] }))
    .mockResolvedValueOnce(response({ data: [{ id: "9", campaign_id: "42", adset_id: "7", name: "Image",
      status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "11", name: "Creative" } }] }))
    .mockResolvedValueOnce(response({ data: [{ campaign_id: "42", account_currency: "USD",
      impressions: "100", clicks: "8", spend: "12.30" }] }))
    .mockResolvedValueOnce(response({ data: [{ ad_id: "9", account_currency: "USD",
      impressions: "50", clicks: "4", spend: "6.20" }] }));
}

describe("Meta account read", () => {
  it("reads campaign and ad inventory and metrics through GET only", async () => {
    const fetchImpl = provider();
    const read = await readMetaAdsAccount(credentials, "2026-11-01", "2026-11-16", fetchImpl);
    expect(read.accountId).toBe("act_123");
    expect(read.campaigns[0]).toMatchObject({ id: "42", spend: "12.30" });
    expect(read.ads[0]).toMatchObject({ id: "9", campaign_id: "42", creative_id: "11", spend: "6.20" });
    expect(read.campaigns[0]?.metrics_observed).toBe(true);
    expect(read.ads[0]?.metrics_observed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    for (const [url, options] of fetchImpl.mock.calls) {
      expect(options?.method).toBe("GET");
      expect(options?.headers).toMatchObject({ Authorization: "Bearer token" });
      expect(String(url)).not.toContain("token");
    }
  });

  it("rejects a different account before inventory", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "act_999", account_id: "999", currency: "USD" }));
    await expect(readMetaAdsAccount(credentials, "2026-11-01", "2026-11-16", fetchImpl))
      .rejects.toThrow("configured ad account identity");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects pagination to another host", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: "act_123", account_id: "123", currency: "USD" }))
      .mockResolvedValueOnce(response({ data: [], paging: { next: "https://example.com/steal" } }));
    await expect(readMetaAdsAccount(credentials, "2026-11-01", "2026-11-16", fetchImpl))
      .rejects.toThrow("pagination left the requested account edge");
  });

  it("marks missing insight rows as unknown even when inventory exists", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: "act_123", account_id: "123", currency: "USD" }))
      .mockResolvedValueOnce(response({ data: [{ id: "42", name: "Leads", status: "ACTIVE", effective_status: "ACTIVE" }] }))
      .mockResolvedValueOnce(response({ data: [{ id: "9", campaign_id: "42", adset_id: "7", name: "Image",
        status: "ACTIVE", effective_status: "ACTIVE" }] }))
      .mockResolvedValueOnce(response({ data: [] }))
      .mockResolvedValueOnce(response({ data: [] }));
    const read = await readMetaAdsAccount(credentials, "2026-11-01", "2026-11-16", fetchImpl);
    expect(read.campaigns[0]?.metrics_observed).toBe(false);
    expect(read.ads[0]?.metrics_observed).toBe(false);
  });
});
