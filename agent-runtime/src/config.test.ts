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
    if (key.startsWith("AGENT_RUNTIME_") || key.startsWith("MASTER_AI_") || key.startsWith("ANTHROPIC_API_KEY") || key === "SUPABASE_URL" || key === "SUPABASE_SERVICE_ROLE_KEY" || key === "PORT") {
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

describe("Master AI spend limits", () => {
  it("defaults well above real usage rather than to no limit at all", () => {
    const config = loadConfig();
    expect(config.masterAiDailyLimitUsd).toBe(20);
    expect(config.masterAiConversationLimitUsd).toBe(5);
  });

  it("takes dollars and cents, not whole dollars", () => {
    process.env.MASTER_AI_DAILY_LIMIT_USD = "7.50";
    expect(loadConfig().masterAiDailyLimitUsd).toBe(7.5);
  });

  // Zero is an off switch, not a mistake.
  it("accepts zero as a deliberate stop", () => {
    process.env.MASTER_AI_CONVERSATION_LIMIT_USD = "0";
    expect(loadConfig().masterAiConversationLimitUsd).toBe(0);
  });

  // A ceiling that silently falls back to a default when misconfigured is
  // worse than no ceiling, because it looks like it is holding.
  it("refuses to boot on a negative limit", () => {
    process.env.MASTER_AI_DAILY_LIMIT_USD = "-5";
    expect(() => loadConfig()).toThrow(/non-negative/);
  });

  it("refuses to boot on a limit that is not a number", () => {
    process.env.MASTER_AI_DAILY_LIMIT_USD = "twenty";
    expect(() => loadConfig()).toThrow(/non-negative/);
  });
});
