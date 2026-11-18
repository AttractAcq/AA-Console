import { describe, expect, it, vi } from "vitest";
import { readGoogleAdsAccount } from "./read-only.js";

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
      }]}))
      .mockResolvedValueOnce(body({requestId:"ad-inventory",results:[{
        campaign:{id:"42"},adGroup:{id:"7"},adGroupAd:{
          resourceName:"customers/1234567890/adGroupAds/7~9",status:"ENABLED",
          ad:{id:"9",type:"RESPONSIVE_SEARCH_AD",finalUrls:["https://example.com"],
            responsiveSearchAd:{headlines:[{text:"Lead headline"}],descriptions:[{text:"Lead description"}]}}
        }
      }]}))
      .mockResolvedValueOnce(body({requestId:"ad-metrics",results:[{
        adGroupAd:{resourceName:"customers/1234567890/adGroupAds/7~9"},
        metrics:{impressions:"50",clicks:"4",costMicros:"600000",conversions:1}
      }]}));
    const read = await readGoogleAdsAccount(credentials,"2026-11-01","2026-11-16",fetchImpl);
    expect(read).toEqual({customerId:"1234567890",currency:"USD",
      requestId:"account-req:inventory-req:metrics-req:ad-inventory:ad-metrics",campaigns:[{
        id:"42",name:"Local leads",status:"ENABLED",channel:"SEARCH",metrics_observed:true,
        impressions:"100",clicks:"8",cost_micros:"1230000",conversions:"1.25",
      }],ads:[{resource_name:"customers/1234567890/adGroupAds/7~9",
        campaign_id:"42",ad_group_id:"7",ad_id:"9",status:"ENABLED",
        ad_type:"RESPONSIVE_SEARCH_AD",final_urls:["https://example.com"],
        headlines:["Lead headline"],descriptions:["Lead description"],metrics_observed:true,
        impressions:"50",clicks:"4",cost_micros:"600000",conversions:"1"}]});
    expect(fetchImpl).toHaveBeenCalledTimes(5);
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
      .rejects.toMatchObject({retryable:false,
        message:"Google Ads read returned HTTP 403."});
  });

  it("follows bounded pages and rejects truncated campaign reads", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(body({requestId:"a",results:[{customer:{id:"1234567890",currencyCode:"EUR"}}]}))
      .mockResolvedValueOnce(body({requestId:"b",results:[{campaign:{id:"1",name:"One",status:"PAUSED",advertisingChannelType:"SEARCH"}}],nextPageToken:"next"}))
      .mockResolvedValueOnce(body({requestId:"b2",results:[{campaign:{id:"2",name:"Two",status:"ENABLED",advertisingChannelType:"SEARCH"}}]}))
      .mockResolvedValueOnce(body({requestId:"c",results:[]}))
      .mockResolvedValueOnce(body({requestId:"d",results:[]}))
      .mockResolvedValueOnce(body({requestId:"e",results:[]}));
    const read = await readGoogleAdsAccount(credentials,"2026-11-01","2026-11-16",fetchImpl);
    expect(read.campaigns).toHaveLength(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body)).pageToken).toBe("next");
    expect(read.campaigns[0]?.cost_micros).toBe("0");
    expect(read.campaigns.every((campaign) => campaign.metrics_observed === false)).toBe(true);
  });

  it("rejects an ad whose resource identity does not match the exact customer and ad group", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(body({requestId:"a",results:[{customer:{id:"1234567890",currencyCode:"USD"}}]}))
      .mockResolvedValueOnce(body({requestId:"b",results:[{campaign:{id:"42",name:"Lead search",status:"ENABLED",advertisingChannelType:"SEARCH"}}]}))
      .mockResolvedValueOnce(body({requestId:"c",results:[]}))
      .mockResolvedValueOnce(body({requestId:"d",results:[{campaign:{id:"42"},adGroup:{id:"7"},
        adGroupAd:{resourceName:"customers/9999999999/adGroupAds/7~9",status:"ENABLED",
          ad:{id:"9",type:"RESPONSIVE_SEARCH_AD"}}}]}))
      .mockResolvedValueOnce(body({requestId:"e",results:[]}));
    await expect(readGoogleAdsAccount(credentials,"2026-11-01","2026-11-16",fetchImpl))
      .rejects.toThrow("ad resource identity was malformed");
  });
});
