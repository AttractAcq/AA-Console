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

const empty: OnboardingData = {
  contact: null,
  business: null,
  brand: null,
  integrations: [],
  manualComplete: [],
};

const full: OnboardingData = {
  contact: { primary_contact: "Kyle", website: "https://example.co.za" },
  business: {
    business_overview: "Implant dentistry",
    ideal_customer: "Failed bridge",
    main_offer: "Full arch",
    competitors: "Named",
  },
  brand: { colour_primary: "#142B23", imagery_style: "Documentary" },
  integrations: [{ provider: "meta" }, { provider: "instagram" }],
  manualComplete: ["call"],
};

describe("a step's status is derived, never stored", () => {
  it("is done when the data the app needs is there", () => {
    for (const step of ONBOARDING_STEPS) {
      expect(stepState(step.key, full), step.key).toBe("done");
    }
    expect(progress(full)).toEqual({ done: 5, total: 5 });
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
    expect(missingFor("credentials", empty).sort()).toEqual(["instagram", "meta"]);
  });

  it("is partial with one of the two", () => {
    const one = { ...empty, integrations: [{ provider: "meta" }] };
    expect(stepState("credentials", one)).toBe("partial");
    expect(missingFor("credentials", one)).toEqual(["instagram"]);
  });

  it("is not satisfied by a credential that does not sync", () => {
    // Storing a Resend key is a useful thing to do and is not onboarding.
    const resend = { ...empty, integrations: [{ provider: "resend" }] };
    expect(stepState("credentials", resend)).toBe("empty");
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

  it("returns nothing when there is nothing left", () => {
    expect(nextStep(full)).toBeNull();
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
