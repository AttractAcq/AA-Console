import { describe, expect, it, vi } from "vitest";
import { updateMetaPageField } from "./meta-page.js";

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const request = {
  accessToken: "page-token", pageId: "123456", field: "about",
  currentValue: "Before", value: "After",
};

describe("isolated Facebook Page field transport", () => {
  it("checks Page-token identity and reviewed before value before one-field POST", async () => {
    const assertPrewrite = vi.fn(async () => {});
    let pageReads = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/me?")) return json({ id: "123456" });
      if (init?.method === "POST") return json({ success: true });
      pageReads += 1;
      return json({ id: "123456", about: pageReads === 1 ? "Before" : "After" });
    }) as unknown as typeof fetch;
    await expect(updateMetaPageField({ ...request, assertPrewrite, fetchImpl }))
      .resolves.toEqual({ providerRef: "facebook_page:123456#about", readbackValue: "After" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(assertPrewrite).toHaveBeenCalledTimes(1);
    const post = fetchImpl.mock.calls[2]!;
    expect(String(post[0])).toBe("https://graph.facebook.com/v27.0/123456");
    expect(new URLSearchParams(String((post[1] as RequestInit).body)).get("about")).toBe("After");
  });

  it("refuses a User token or another Page token before Page read", async () => {
    const fetchImpl = vi.fn(async () => json({ id: "other" })) as unknown as typeof fetch;
    await expect(updateMetaPageField({ ...request, assertPrewrite: vi.fn(), fetchImpl }))
      .rejects.toThrow(/not the exact Facebook Page token/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses live field drift before the one-shot claim", async () => {
    const assertPrewrite = vi.fn();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("/me?") ? json({ id: "123456" })
        : json({ id: "123456", about: "Someone changed it" })) as unknown as typeof fetch;
    await expect(updateMetaPageField({ ...request, assertPrewrite, fetchImpl }))
      .rejects.toThrow(/differs from the reviewed before value/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(assertPrewrite).not.toHaveBeenCalled();
  });

  it("writes the Page website field without changing any other field", async () => {
    const value = "https://example.com/new";
    let reads = 0;
    const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/me?")) return json({ id: "123456" });
      if (init?.method === "POST") return json({ success: true });
      reads += 1;
      return json({ id: "123456", website: reads === 1 ? "https://example.com/old" : value });
    });
    await expect(updateMetaPageField({ ...request, field: "website_url",
      currentValue: "https://example.com/old", value,
      assertPrewrite: vi.fn(), fetchImpl: mock as unknown as typeof fetch }))
      .resolves.toMatchObject({ readbackValue: value });
    expect(String(mock.mock.calls[1]![0])).toContain("fields=id%2Cwebsite");
    const sent = new URLSearchParams(String((mock.mock.calls[2]![1] as RequestInit).body));
    expect([...sent.entries()]).toEqual([["website", value]]);
  });

  it("validates writable field, about limit and website URL before transport", async () => {
    const fetchImpl = vi.fn();
    for (const bad of [
      { ...request, field: "bio" },
      { ...request, value: "x".repeat(101) },
      { ...request, field: "website_url", value: "not a url" },
    ]) {
      await expect(updateMetaPageField({ ...bad, assertPrewrite: vi.fn(), fetchImpl }))
        .rejects.toThrow();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("holds an uncertain POST and a mismatched readback", async () => {
    const dropped = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/me?")) return json({ id: "123456" });
      if (init?.method === "POST") throw new Error("socket dropped");
      return json({ id: "123456", about: "Before" });
    }) as unknown as typeof fetch;
    await expect(updateMetaPageField({ ...request, assertPrewrite: vi.fn(), fetchImpl: dropped }))
      .rejects.toThrow(/outcome is uncertain/);
    expect(dropped).toHaveBeenCalledTimes(3);

    let pageReads = 0;
    const stale = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/me?")) return json({ id: "123456" });
      if (init?.method === "POST") return json({ success: true });
      pageReads += 1;
      return json({ id: "123456", about: pageReads === 1 ? "Before" : "Still before" });
    }) as unknown as typeof fetch;
    await expect(updateMetaPageField({ ...request, assertPrewrite: vi.fn(), fetchImpl: stale }))
      .rejects.toThrow(/readback differs/);
  });
});
