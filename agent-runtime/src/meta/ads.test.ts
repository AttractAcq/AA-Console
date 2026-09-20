import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAd, createAdSet, createCampaign, classifyWrite, refusesToSendLive } from "./ads.js";

const account = { accessToken: "t", accountId: "act_1" };
const paused = { name: "x", status: "PAUSED" };

function respond(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

afterEach(() => vi.unstubAllGlobals());

describe("nothing here can create a live object", () => {
  it("refuses a campaign, ad set or ad that is not paused", async () => {
    const fetchMock = respond({ id: "1" });
    vi.stubGlobal("fetch", fetchMock);
    const live = { name: "x", status: "ACTIVE" };

    await expect(createCampaign(account, live)).rejects.toThrow(/Refusing to create a campaign/);
    await expect(createAdSet(account, live)).rejects.toThrow(/Refusing to create an ad set/);
    await expect(createAd(account, live)).rejects.toThrow(/Refusing to create an ad/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a payload with no status at all", () => {
    expect(() => refusesToSendLive({}, "a campaign")).toThrow(/status undefined/);
    expect(() => refusesToSendLive({ status: "paused" }, "a campaign")).toThrow(/Refusing/);
  });

  it("says where launching happens instead", () => {
    expect(() => refusesToSendLive({ status: "ACTIVE" }, "a campaign")).toThrow(/Ads Manager/);
  });

  /**
   * The guard that survives a refactor. The two modules above hard-code
   * PAUSED, and this proves that no edit has introduced a way to send
   * anything else — including one that looks reasonable in review.
   */
  it("contains no ACTIVE status anywhere in the package", () => {
    const dir = join(import.meta.dirname, ".");
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, `${file} mentions ACTIVE`).not.toMatch(/["']ACTIVE["']/);
    }
  });
});

describe("writing to the account", () => {
  it("posts the campaign and returns the id Meta gave it", async () => {
    const fetchMock = respond({ id: "23851" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createCampaign(account, paused)).resolves.toEqual({ id: "23851" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://graph.facebook.com/v21.0/act_1/campaigns");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer t");
    expect(JSON.parse(init.body)).toEqual(paused);
  });

  it("posts ad sets and ads to their own edges", async () => {
    const fetchMock = respond({ id: "1" });
    vi.stubGlobal("fetch", fetchMock);
    await createAdSet(account, paused);
    await createAd(account, paused);
    expect(fetchMock.mock.calls[0]![0]).toContain("/adsets");
    expect(fetchMock.mock.calls[1]![0]).toContain("/ads");
  });

  it("treats a success with no id as a failure", async () => {
    vi.stubGlobal("fetch", respond({ ok: true }));
    await expect(createCampaign(account, paused)).rejects.toThrow(/returned no id/);
  });

  it("does not retry a network failure silently", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket hang up"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createCampaign(account, paused)).rejects.toThrow(/Could not reach/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("classifyWrite", () => {
  const err = (code: number) => ({ error: { message: "nope", code } });

  it("marks an expired token and a missing scope as not worth retrying", () => {
    for (const code of [190, 200, 10, 272]) {
      const e = classifyWrite(400, err(code));
      expect(e.retryable, String(code)).toBe(false);
      expect(e.message).toContain("ads_management");
    }
  });

  it("marks rate limits as worth retrying", () => {
    for (const code of [4, 17, 32, 613, 1, 2]) {
      expect(classifyWrite(400, err(code)).retryable, String(code)).toBe(true);
    }
  });

  it("marks an ad account limit as not worth retrying", () => {
    const e = classifyWrite(400, err(1487));
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("ad account limit");
  });

  it("retries a 429 or a Meta-side failure", () => {
    expect(classifyWrite(429, null).retryable).toBe(true);
    expect(classifyWrite(503, null).retryable).toBe(true);
    expect(classifyWrite(400, null).retryable).toBe(false);
  });

  it("keeps the status Meta returned", () => {
    expect(classifyWrite(403, err(200)).status).toBe(403);
  });
});
