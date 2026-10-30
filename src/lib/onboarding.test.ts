import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEPS,
  SYNCING_PROVIDERS,
  missingFor,
  nextStep,
  progress,
  stepState,
  type OnboardingData,
} from "./onboarding";
import type { IntegrationEvidence } from "./integrationReadiness";

const integration = (provider: "meta" | "instagram", client_id = "client-1"): IntegrationEvidence => ({
  client_id,
  provider,
  credential_secret_id: `${provider}-vault-id`,
  credential_label: provider === "meta" ? "act_123" : "17841400000000000",
  ad_account_id: provider === "meta" ? "act_123" : null,
  status: "connected",
  token_expires_at: null,
  last_checked_at: null,
  ingest_enabled: true,
});

const empty: OnboardingData = {
  clientId: "client-1",
  observedAtMs: Date.parse("2026-10-30T12:00:00Z"),
  contact: null,
  business: null,
  brand: null,
  integrations: [],
  manualComplete: [],
};

const full: OnboardingData = {
  clientId: "client-1",
  observedAtMs: Date.parse("2026-10-30T12:00:00Z"),
  contact: { primary_contact: "Kyle", website: "https://example.co.za" },
  business: {
    business_overview: "Implant dentistry",
    ideal_customer: "Failed bridge",
    main_offer: "Full arch",
    competitors: "Named",
  },
  brand: { colour_primary: "#142B23", imagery_style: "Documentary" },
  integrations: [integration("meta"), integration("instagram")],
  manualComplete: ["call"],
};

describe("a step's status is derived, never stored", () => {
  it("derives completed information without calling unverified provider access done", () => {
    for (const step of ONBOARDING_STEPS.filter((step) => step.key !== "credentials")) {
      expect(stepState(step.key, full), step.key).toBe("done");
    }
    expect(stepState("credentials", full)).toBe("partial");
    expect(progress(full)).toEqual({ done: 4, total: 5 });
  });

  it("is empty on a client nobody has touched", () => {
    for (const step of ONBOARDING_STEPS) {
      expect(stepState(step.key, empty), step.key).toBe("empty");
    }
    expect(progress(empty)).toEqual({ done: 0, total: 5 });
  });

  it("counts a step filled in from its own panel later", () => {
    // Somebody completing Brand & Design directly must show as done here
    // without anything telling onboarding about it. That is the whole point
    // of deriving from the destination table rather than storing a claim.
    const viaPanel = { ...empty, brand: { colour_primary: "#000", imagery_style: "Studio" } };
    expect(stepState("brand", viaPanel)).toBe("done");
  });
});

// A client with a website but no primary contact is not "not started", and
// showing it as empty loses the work somebody already did.
describe("half-filled is its own state", () => {
  it("reports partial when some of the required fields are in", () => {
    expect(stepState("contact", { ...empty, contact: { website: "https://x.co" } })).toBe("partial");
  });

  it("names exactly what is still missing", () => {
    expect(missingFor("contact", { ...empty, contact: { website: "https://x.co" } })).toEqual([
      "primary_contact",
    ]);
  });

  it("does not count whitespace as an answer", () => {
    expect(stepState("contact", { ...empty, contact: { primary_contact: "   ", website: "  " } })).toBe(
      "empty",
    );
  });
});

describe("credentials", () => {
  it("wants both providers that actually sync", () => {
    expect([...SYNCING_PROVIDERS]).toEqual(["meta", "instagram"]);
    expect(missingFor("credentials", empty).join(" ")).toMatch(/meta integration/);
    expect(missingFor("credentials", empty).join(" ")).toMatch(/instagram integration/);
  });

  it("is partial with one of the two", () => {
    const one = { ...empty, integrations: [integration("meta")] };
    expect(stepState("credentials", one)).toBe("partial");
    expect(missingFor("credentials", one).join(" ")).toMatch(/instagram integration/);
  });

  it("is not satisfied by a credential that does not sync", () => {
    // Storing a Resend key is a useful thing to do and is not onboarding.
    const resend = { ...empty, integrations: [{ ...integration("meta"), provider: "resend" }] };
    expect(stepState("credentials", resend)).toBe("empty");
  });

  it("does not mark a pair of connected rows ready without provider readback and scopes", () => {
    expect(missingFor("credentials", full).join(" ")).toMatch(/meta account access, scopes and action rights verification/);
    expect(missingFor("credentials", full).join(" ")).toMatch(/instagram account access, scopes and action rights verification/);
  });

  it("keeps an unhealthy integration blocked even when the other client's row is healthy", () => {
    const unhealthy = { ...full, integrations: [integration("meta"), { ...integration("instagram"), status: "revoked" }] };
    expect(stepState("credentials", unhealthy)).toBe("partial");
    expect(missingFor("credentials", unhealthy).join(" ")).toMatch(/instagram status is revoked/);
    const otherClient = { ...full, integrations: [integration("meta", "client-2"), integration("instagram", "client-2")] };
    expect(stepState("credentials", otherClient)).toBe("empty");
    expect(missingFor("credentials", otherClient).join(" ")).toMatch(/meta integration/);
  });
});

describe("the call", () => {
  it("is the only step ticked by hand, because there is nothing to read", () => {
    expect(ONBOARDING_STEPS.filter((s) => s.manual).map((s) => s.key)).toEqual(["call"]);
    expect(stepState("call", empty)).toBe("empty");
    expect(stepState("call", { ...empty, manualComplete: ["call"] })).toBe("done");
  });
});

describe("where to send somebody next", () => {
  it("offers a half-finished step before an untouched one", () => {
    // Usually the one they were in the middle of.
    const data = { ...empty, brand: { colour_primary: "#000" } };
    expect(nextStep(data)?.key).toBe("brand");
  });

  it("falls back to the first untouched step", () => {
    expect(nextStep(empty)?.key).toBe("contact");
  });

  it("keeps provider verification as the next step when other information is complete", () => {
    expect(nextStep(full)?.key).toBe("credentials");
  });
});

describe("every step says where its data lives", () => {
  it("names a real tab, so the answer can be edited later", () => {
    // Onboarding is where information is collected, not where it is kept.
    for (const step of ONBOARDING_STEPS) {
      // A path after /clients/:id/, not a bare tab name — Business Context
      // lives under delivery/, not account/, and the first version linked to
      // a route that did not exist.
      expect(step.livesAt.path, step.key).toMatch(/^(account|delivery)\//);
      expect(step.livesAt.label.length, step.key).toBeGreaterThan(0);
      expect(step.why.length, step.key).toBeGreaterThan(40);
    }
  });
});
