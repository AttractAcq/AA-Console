import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anthropicKeyForAgent, loadConfig } from "./config.js";

const REQUIRED = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  ANTHROPIC_API_KEY: "shared-key",
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AGENT_RUNTIME_") || key.startsWith("ANTHROPIC_API_KEY") || key === "SUPABASE_URL" || key === "SUPABASE_SERVICE_ROLE_KEY" || key === "PORT") {
      delete process.env[key];
    }
  }
  Object.assign(process.env, REQUIRED);
});

afterEach(() => {
  process.env = savedEnv;
});

describe("loadConfig", () => {
  it("fails closed when a required variable is missing", () => {
    delete process.env.SUPABASE_URL;
    expect(() => loadConfig()).toThrow(/SUPABASE_URL/);
  });

  it("applies defaults when optional variables are absent", () => {
    const config = loadConfig();
    expect(config.model).toBe("claude-opus-5");
    expect(config.enabled).toBe(true);
    expect(config.concurrency).toBe(2);
    expect(config.leaseSeconds).toBe(900);
    expect(config.sharedSecret).toBeNull();
  });

  it("rejects a lease outside the 30-3600s range claim_agent_job accepts", () => {
    process.env.AGENT_RUNTIME_LEASE_SECONDS = "10";
    expect(() => loadConfig()).toThrow(/AGENT_RUNTIME_LEASE_SECONDS/);

    process.env.AGENT_RUNTIME_LEASE_SECONDS = "3601";
    expect(() => loadConfig()).toThrow(/AGENT_RUNTIME_LEASE_SECONDS/);
  });

  it("treats AGENT_RUNTIME_ENABLED=false as disabled", () => {
    process.env.AGENT_RUNTIME_ENABLED = "false";
    expect(loadConfig().enabled).toBe(false);
  });

  it("rejects a non-positive-integer for an int env var", () => {
    process.env.AGENT_RUNTIME_CONCURRENCY = "0";
    expect(() => loadConfig()).toThrow(/AGENT_RUNTIME_CONCURRENCY/);
  });

  it("picks up a per-agent Anthropic key override by suffix", () => {
    process.env.ANTHROPIC_API_KEY_COMPETITOR = "competitor-key";
    const config = loadConfig();
    expect(anthropicKeyForAgent(config, "competitor")).toBe("competitor-key");
    expect(anthropicKeyForAgent(config, "icp")).toBe("shared-key");
  });

  it("falls back to the shared key when no override is set", () => {
    const config = loadConfig();
    expect(anthropicKeyForAgent(config, "brief")).toBe("shared-key");
  });
});
