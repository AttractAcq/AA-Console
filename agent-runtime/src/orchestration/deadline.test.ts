import { describe, expect, it, vi, afterEach } from "vitest";
import { deadlineFromNow } from "./deadline.js";
import type { RuntimeConfig } from "../config.js";

const config = (maxJobSeconds: number) => ({ maxJobSeconds }) as RuntimeConfig;

afterEach(() => vi.useRealTimers());

describe("deadlineFromNow", () => {
  it("is the job's maximum age from this moment", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
    expect(deadlineFromNow(config(1800))).toBe(Date.parse("2026-09-07T12:30:00Z"));
  });

  // Deliberately the same number the worker stops renewing the lease at, so a
  // job stops working at the instant it stops being renewable rather than
  // becoming a zombie that still spends.
  it("matches the lease-renewal cap, so execution and renewal end together", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    expect(deadlineFromNow(config(900))).toBe(900_000);
  });

  it("moves with each attempt rather than being fixed for the job", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const first = deadlineFromNow(config(60));
    vi.setSystemTime(31_000);
    const retry = deadlineFromNow(config(60));
    expect(retry - first).toBe(30_000);
  });
});
