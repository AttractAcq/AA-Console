import { describe, expect, it, vi } from "vitest";
import { GoogleAdsReadError, readGoogleAdsAccount } from "./read-only.js";

const credentials = { customerId:"1234567890",accessToken:"oauth-token",
  developerToken:"developer-token",loginCustomerId:"0987654321" };
const body = (value: unknown, status=200) => new Response(JSON.stringify(value), {
  status,headers:{"content-type":"application/json"},
});

describe("Google Ads read-only inventory", () => {
  it("binds the exact account and maps campaign metrics without a mutation request", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(body({requestId:"account-req",results:[{customer:{id:"1234567890",currencyCode:"USD"}}]}))
      .mockResolvedValueOnce(body({requestId:"inventory-req",results:[{
        campaign:{id:"42",name:"Local leads",status:"ENABLED",advertisingChannelType:"SEARCH"},
      }]}))
      .mockResolvedValueOnce(body({requestId:"metrics-req",results:[{
        campaign:{id:"42"},metrics:{impressions:"100",clicks:"8",costMicros:"1230000",conversions:1.25},
      }]}));
    const read = await readGoogleAdsAccount(credentials,"2026-11-01","2026-11-16",fetchImpl);
    expect(read).toEqual({customerId:"1234567890",currency:"USD",
      requestId:"account-req:inventory-req:metrics-req",campaigns:[{
        id:"42",name:"Local leads",status:"ENABLED",channel:"SEARCH",
        impressions:"100",clicks:"8",cost_micros:"1230000",conversions:"1.25",
      }]});
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [url, options] of fetchImpl.mock.calls) {
      expect(url).toBe("https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search");
      expect(options?.method).toBe("POST");
      expect(options?.headers).toMatchObject({
        Authorization:"Bearer oauth-token","developer-token":"developer-token",
        "login-customer-id":"0987654321",
      });
      expect(JSON.parse(String(options?.body)).query).toMatch(/^SELECT /);
    }
  });

  it("rejects a different customer before reading campaigns", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(body({
      requestId:"request",results:[{customer:{id:"9999999999",currencyCode:"USD"}}],
    }));
    await expect(readGoogleAdsAccount(credentials,"2026-11-01","2026-11-16",fetchImpl))
      .rejects.toThrow("configured customer identity");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects missing developer token and provider auth failures without leaking credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(readGoogleAdsAccount({...credentials,developerToken:""},
      "2026-11-01","2026-11-16",fetchImpl)).rejects.toThrow("configuration is incomplete");
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValue(body({error:{message:"secret token"}},403));
    await expect(readGoogleAdsAccount(credentials,"2026-11-01","2026-11-16",fetchImpl))
      .rejects.toMatchObject<Partial<GoogleAdsReadError>>({retryable:false,
        message:"Google Ads read returned HTTP 403."});
  });

  it("follows bounded pages and rejects truncated campaign reads", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(body({requestId:"a",results:[{customer:{id:"1234567890",currencyCode:"EUR"}}]}))
      .mockResolvedValueOnce(body({requestId:"b",results:[{campaign:{id:"1",name:"One",status:"PAUSED",advertisingChannelType:"SEARCH"}}],nextPageToken:"next"}))
      .mockResolvedValueOnce(body({requestId:"b2",results:[{campaign:{id:"2",name:"Two",status:"ENABLED",advertisingChannelType:"SEARCH"}}]}))
      .mockResolvedValueOnce(body({requestId:"c",results:[]}));
    const read = await readGoogleAdsAccount(credentials,"2026-11-01","2026-11-16",fetchImpl);
    expect(read.campaigns).toHaveLength(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body)).pageToken).toBe("next");
    expect(read.campaigns[0]?.cost_micros).toBe("0");
  });
});
