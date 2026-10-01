import { describe, expect, it } from "vitest";
import { decideMotion, readHiggsfieldEnv } from "./motion.js";

describe("motion without Higgsfield credentials", () => {
  it("pauses when the key is missing and does not throw", () => {
    expect(() => decideMotion({ apiKey: "", apiSecret: "present-secret" })).not.toThrow();
    const decision = decideMotion({ apiKey: "   ", apiSecret: "present-secret" });
    expect(decision.proceed).toBe(false);
    expect(decision.stage).toBe("paused");
    expect(decision.retryable).toBe(false);
    expect(decision.reason).toBe("missing_higgsfield_credentials");
    expect(decision.message).toContain("HIGGSFIELD_API_KEY");
    expect(decision.message).toContain("No Higgsfield request was sent");
    expect(decision.message).not.toContain("present-secret");
  });

  it("pauses when the secret is missing", () => {
    const decision = decideMotion({ apiKey: "present-key", apiSecret: "" });
    expect(decision.proceed).toBe(false);
    expect(decision.message).toContain("HIGGSFIELD_API_SECRET");
    expect(decision.message).not.toContain("present-key");
  });

  it("names both when both are missing", () => {
    const decision = decideMotion({ apiKey: undefined, apiSecret: null });
    expect(decision.message).toContain("HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET");
    expect(decision.message).toMatch(/are not set/);
  });

  it("still does not proceed when both are set", () => {
    const decision = decideMotion({ apiKey: "key", apiSecret: "secret" });
    expect(decision.proceed).toBe(false);
    expect(decision.reason).toBe("adapter_not_enabled");
    expect(decision.retryable).toBe(false);
    expect(decision.message).toContain("No Higgsfield request was sent");
    expect(decision.message).not.toContain("secret");
  });

  it("treats a blank env value as missing", () => {
    const env = readHiggsfieldEnv({ HIGGSFIELD_API_KEY: "  ", HIGGSFIELD_API_SECRET: "s" });
    expect(decideMotion(env).reason).toBe("missing_higgsfield_credentials");
  });
});
