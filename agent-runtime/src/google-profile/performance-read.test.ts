import { describe, expect, it, vi } from "vitest";
import { ProfilePerformanceReadError, readProfilePerformance } from "./performance-read.js";

const input = {
  locationRef: "accounts/123/locations/456", accessToken: "secret",
  from: "2026-11-01", through: "2026-11-02",
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Business Profile performance transport", () => {
  it("uses the v1 GET endpoint and preserves omitted series or dates as unknown", async () => {
    const fetchImpl = vi.fn(async () => response({ multiDailyMetricTimeSeries: [{
      dailyMetricTimeSeries: [{ dailyMetric: "WEBSITE_CLICKS", timeSeries: {
        datedValues: [
          { date: { year: 2026, month: 11, day: 1 }, value: "12" },
          { date: { year: 2026, month: 11, day: 2 } },
        ],
      } }],
    }] })) as unknown as typeof fetch;
    const result = await readProfilePerformance({ ...input, fetchImpl });
    const [url, options] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toContain("/v1/locations/456:fetchMultiDailyMetricsTimeSeries");
    expect(new URL(String(url)).searchParams.getAll("dailyMetrics")).toContain("WEBSITE_CLICKS");
    expect(options).toMatchObject({ method: "GET", redirect: "error" });
    expect(result.observedMetrics).toEqual(["WEBSITE_CLICKS"]);
    expect(result.points).toEqual([
      { metric: "WEBSITE_CLICKS", day: "2026-11-01", value: "12" },
      { metric: "WEBSITE_CLICKS", day: "2026-11-02", value: "0" },
    ]);
  });

  it("refuses a nonnumeric location before provider access", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(readProfilePerformance({ ...input,
      locationRef: "accounts/a/locations/../../other", fetchImpl }))
      .rejects.toBeInstanceOf(ProfilePerformanceReadError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not invent zero for an omitted metric series", async () => {
    const result = await readProfilePerformance({ ...input,
      fetchImpl: vi.fn(async () => response({})) as unknown as typeof fetch });
    expect(result.observedMetrics).toEqual([]);
    expect(result.points).toEqual([]);
  });

  it("keeps a named metric with no dated values unknown", async () => {
    const result = await readProfilePerformance({ ...input,
      fetchImpl: vi.fn(async () => response({ multiDailyMetricTimeSeries: [{
        dailyMetricTimeSeries: [{ dailyMetric: "CALL_CLICKS" }],
      }] })) as unknown as typeof fetch });
    expect(result.observedMetrics).toEqual(["CALL_CLICKS"]);
    expect(result.points).toEqual([]);
  });

  it("rejects a duplicate date or a point outside the requested range", async () => {
    const item = { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [
      { date: { year: 2026, month: 11, day: 1 }, value: "3" },
      { date: { year: 2026, month: 11, day: 1 }, value: "4" },
    ] } };
    await expect(readProfilePerformance({ ...input,
      fetchImpl: vi.fn(async () => response({ multiDailyMetricTimeSeries: [
        { dailyMetricTimeSeries: [item] },
      ] })) as unknown as typeof fetch })).rejects.toThrow(/duplicate/);
    item.timeSeries.datedValues[1]!.date.day = 3;
    await expect(readProfilePerformance({ ...input,
      fetchImpl: vi.fn(async () => response({ multiDailyMetricTimeSeries: [
        { dailyMetricTimeSeries: [item] },
      ] })) as unknown as typeof fetch })).rejects.toThrow(/outside/);
  });

  it("marks retryable HTTP failures without returning token or provider body", async () => {
    await expect(readProfilePerformance({ ...input,
      fetchImpl: vi.fn(async () => response({ error: "secret" }, 429)) as unknown as typeof fetch }))
      .rejects.toMatchObject({ retryable: true, message: "Business Profile performance read returned HTTP 429." });
  });
});
