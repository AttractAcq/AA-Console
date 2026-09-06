import { describe, expect, it, afterEach } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  ANTHROPIC_API_KEY: "anthropic-key",
};

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function withEnv(extra: Record<string, string> = {}) {
  process.env = { ...saved, ...base, ...extra };
  return loadConfig();
}

describe("timeout and job-age bounds", () => {
  it("bounds a model call by default, so a stalled stream cannot hang forever", () => {
    const config = withEnv();
    expect(config.providerTimeoutMs).toBeGreaterThan(0);
    expect(Number.isFinite(config.providerTimeoutMs)).toBe(true);
  });

  it("caps how long a job may hold its lease by default", () => {
    const config = withEnv();
    expect(config.maxJobSeconds).toBeGreaterThan(0);
    expect(Number.isFinite(config.maxJobSeconds)).toBe(true);
  });

  it("lets a job outlive several lease periods before the cap bites", () => {
    // The cap is a backstop for a wedged job, not a limit on a slow one. If
    // it were shorter than the lease, a healthy long run would be reclaimed
    // out from under itself.
    const config = withEnv();
    expect(config.maxJobSeconds).toBeGreaterThan(config.leaseSeconds);
  });

  it("gives the provider timeout room inside the job cap", () => {
    // Otherwise the lease is dropped while the call it is waiting on is
    // still legitimately running.
    const config = withEnv();
    expect(config.maxJobSeconds * 1000).toBeGreaterThan(config.providerTimeoutMs);
  });

  it("takes both from the environment", () => {
    const config = withEnv({
      AGENT_RUNTIME_PROVIDER_TIMEOUT_MS: "120000",
      AGENT_RUNTIME_MAX_JOB_SECONDS: "900",
    });
    expect(config.providerTimeoutMs).toBe(120_000);
    expect(config.maxJobSeconds).toBe(900);
  });

  it("refuses a nonsensical value rather than silently using it", () => {
    expect(() => withEnv({ AGENT_RUNTIME_PROVIDER_TIMEOUT_MS: "0" })).toThrow();
    expect(() => withEnv({ AGENT_RUNTIME_MAX_JOB_SECONDS: "-5" })).toThrow();
  });
});
