import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import { probePageForm } from "./page-deploy.js";

/**
 * The probe, which is the half of page deployment that matters.
 *
 * Publishing is a commit and a commit is easy to verify. A page whose form
 * posts nowhere looks exactly like one that works, so the assertions here are
 * about what the probe refuses to call a pass:
 *
 *   the endpoint could not be reached, or answered an error
 *   the submission was accepted and no lead appeared
 *   a lead appeared without consent
 *   a lead appeared against the wrong campaign
 *
 * It posts to the same public endpoint a customer would, because a probe that
 * wrote directly to client_leads would pass while the path it is meant to
 * test was broken.
 */

const config = {
  publicRuntimeBase: "https://runtime.attractacq.com",
} as RuntimeConfig;

const ARGS = { clientId: "client-1", campaignId: "camp-1", token: "a".repeat(64) };

function database(lead: Record<string, unknown> | null, options: { readError?: string } = {}) {
  const updates: Record<string, unknown>[] = [];
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () =>
        options.readError
          ? { data: null, error: { message: options.readError } }
          : { data: lead, error: null },
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        return { eq: async () => ({ error: null }) };
      },
    });
    void table;
    return chain;
  });
  return { sb: { from } as unknown as SupabaseClient, updates };
}

const ok = () =>
  vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

const goodLead = {
  id: "lead-1",
  consent_given_at: "2026-10-24T09:00:00Z",
  consent_wording: "I agree to being contacted.",
  source_client_campaign_id: "camp-1",
  source_channel: "page_form",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("what it posts", () => {
  it("submits through the public endpoint a customer would use", async () => {
    const fetchImpl = ok();
    await probePageForm(database(goodLead).sb, config, ARGS, fetchImpl);

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toBe("https://runtime.attractacq.com/public/lead/submit");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ARGS.token}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // Consent, because a submission without it is refused — and the probe has
    // to exercise the path a real person takes, not a shortcut around it.
    expect(body.consent).toBe(true);
    expect(String(body.email)).toContain("@probe.attractacq.com");
    expect(String(body.submission_id)).toContain("probe-");
  });

  it("marks the lead it creates as a probe", async () => {
    const { sb, updates } = database(goodLead);
    await probePageForm(sb, config, ARGS, ok());
    // Real in every other respect, because a probe that wrote somewhere else
    // would be testing the wrong path.
    expect(updates).toEqual([{ is_probe: true }]);
  });
});

describe("what it will not call a pass", () => {
  it("an endpoint that cannot be reached", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const result = await probePageForm(database(goodLead).sb, config, ARGS, fetchImpl);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("could not be reached");
  });

  it("an endpoint that refuses the submission", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "This form is not accepting submissions." }), {
        status: 404,
      }),
    ) as unknown as typeof fetch;
    const result = await probePageForm(database(goodLead).sb, config, ARGS, fetchImpl);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("404");
    expect(result.leadId).toBeNull();
  });

  it("a lead that arrived without consent", async () => {
    const result = await probePageForm(
      database({ ...goodLead, consent_given_at: null, consent_wording: null }).sb,
      config,
      ARGS,
      ok(),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("without consent");
    // The lead is still named, because somebody has to be able to look at it.
    expect(result.leadId).toBe("lead-1");
  });

  it("a lead attributed to no campaign", async () => {
    const result = await probePageForm(
      database({ ...goodLead, source_client_campaign_id: null }).sb,
      config,
      ARGS,
      ok(),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("campaign");
  });

  it("a lead attributed to the wrong campaign", async () => {
    const result = await probePageForm(
      database({ ...goodLead, source_client_campaign_id: "a-different-campaign" }).sb,
      config,
      ARGS,
      ok(),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("the right campaign");
  });

  it("a database it could not read the lead back from", async () => {
    const result = await probePageForm(
      database(goodLead, { readError: "permission denied" }).sb,
      config,
      ARGS,
      ok(),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("permission denied");
  });
});

describe("what it will", () => {
  it("passes when the lead arrives with campaign, source and consent", async () => {
    const result = await probePageForm(database(goodLead).sb, config, ARGS, ok());
    expect(result).toMatchObject({ passed: true, leadId: "lead-1" });
    expect(result.detail).toContain("campaign, source and consent");
  });
});
