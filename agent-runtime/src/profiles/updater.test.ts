import { describe, expect, it, vi } from "vitest";

import { applyProfileChanges, runProfileUpdaterJob, type ClaimedProfileChange } from "./updater.js";
import {
  locationPatchBody, patchLocationField, PlacementTransportError,
} from "../proof-distribution/google-business.js";
import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { AgentJobRow } from "../queue.js";

/**
 * The old profile approval can be approved without a source-owned AAL2 Inbox
 * decision. The worker must refuse before claim or credential read, even
 * when a caller turns on the broad campaign-action switch. Keep the adapter
 * body tests so the held transport remains reviewable for its later release.
 */
const job = { id: "job-1" } as AgentJobRow;
const config = (over: Partial<RuntimeConfig> = {}) =>
  ({ campaignActionsEnabled: true, ...over }) as RuntimeConfig;

const change = (over: Partial<ClaimedProfileChange> = {}): ClaimedProfileChange => ({
  change_id: "ch-1",
  client_id: "c-1",
  surface: "google_business",
  platform: "google",
  field: "description",
  proposed_value: "Garage conversions across Hampshire.",
  location_ref: "accounts/123/locations/456",
  attempts: 1,
  ...over,
});

function database(claimed: ClaimedProfileChange[] = [change()]) {
  const events: Record<string, unknown>[] = [];
  const calls: Array<{ name: string; args: unknown }> = [];
  const rpc = vi.fn(async (name: string, args?: unknown) => {
    calls.push({ name, args });
    if (name === "claim_profile_changes") return { data: claimed, error: null };
    if (name === "integration_secret") return { data: "a-token", error: null };
    return { data: null, error: null };
  });
  const from = vi.fn(() => ({
    insert: vi.fn(async (row: Record<string, unknown>) => {
      events.push(row);
      return { error: null };
    }),
  }));
  return { sb: { rpc, from } as never, rpc, from, calls, events };
}

describe("the global profile-write hold", () => {
  it("claims nothing when external actions are off", async () => {
    const { sb, rpc, from, events } = database();
    const transport = vi.fn();
    const result = await applyProfileChanges(
      sb, config({ campaignActionsEnabled: false }), job, transport as never,
    );
    expect(result.ok).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("agent_job_events");
    expect(transport).not.toHaveBeenCalled();
    expect(String(events[0]!.description)).toMatch(/External campaign actions are off/);
  });

  it.each([
    ["Google Business", [change()]],
    ["Facebook", [change({ surface: "meta", platform: "facebook", field: "about" })]],
  ])("blocks formerly approved %s changes before every claim and provider call", async (_surface, claimed) => {
    const { sb, rpc, from, events } = database(claimed);
    const transport = vi.fn();
    const result = await applyProfileChanges(sb, config(), job, transport as never);

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      failureMessage: expect.stringMatching(/exact-version AAL2 Approval Inbox decision/),
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("agent_job_events");
    expect(transport).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "warn" });
    expect(String(events[0]!.description)).toMatch(/no profile change was claimed/i);
  });

  it("blocks the registered worker entry point despite forged job parameters", async () => {
    const { sb, rpc, from, events } = database();
    const result = await runProfileUpdaterJob(sb, config(), {} as AgentRow, {
      ...job,
      params: { approval_id: "forged", bypass_prewrite_hold: true },
    });

    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("agent_job_events");
    expect(String(events[0]!.description)).toMatch(/no one-shot provider writer and readback receipt/);
  });
});

describe("the body it builds", () => {
  it("nests each field the way Google expects", () => {
    expect(locationPatchBody("title", "Harbour Dental")).toEqual({ title: "Harbour Dental" });
    expect(locationPatchBody("description", "Implants")).toEqual({ profile: { description: "Implants" } });
    expect(locationPatchBody("primary_phone", "+442380000000"))
      .toEqual({ phoneNumbers: { primaryPhone: "+442380000000" } });
    expect(locationPatchBody("website_url", "https://x.test")).toEqual({ websiteUri: "https://x.test" });
  });

  it("sends only the one field, so nothing unlisted is overwritten", () => {
    // The failure this prevents: a whole-object PATCH erasing opening hours
    // nobody mentioned.
    expect(Object.keys(locationPatchBody("description", "x"))).toEqual(["profile"]);
  });

  it("refuses a malformed hours value before the call rather than as a 400", () => {
    expect(() => locationPatchBody("hours", "not json")).toThrow();
  });

  it("refuses a field no adapter writes", () => {
    expect(() => locationPatchBody("categories", "x")).toThrow(/No adapter writes the categories/);
  });
});

describe("the held Google transport in isolation", () => {
  const providerIdentity = (url: RequestInfo | URL): Response | null => {
    const target = String(url);
    if (target.includes("accountmanagement")) {
      return new Response(JSON.stringify({ name: "accounts/123" }), { status: 200 });
    }
    if (target.includes("/v1alpha/accounts/123/locations")) {
      return new Response(JSON.stringify({ locations: [{ name: "locations/456" }] }), { status: 200 });
    }
    return null;
  };
  const request = {
    accessToken: "test-token",
    accountRef: "accounts/123/locations/456",
    field: "description",
    value: "Approved exact description",
    currentValue: "Old exact description",
    assertPrewrite: vi.fn(async () => {}),
  };

  it("compares the live before value, attests immediately before PATCH and reads back", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      providerIdentity(url) ?? new Response(JSON.stringify({ name: "locations/456", profile: {
        description: init?.method === "PATCH" || fetchImpl.mock.calls.length === 5
          ? request.value : request.currentValue,
      } }), { status: 200 }));
    const result = await patchLocationField({ ...request, fetchImpl: fetchImpl as never });
    expect(result).toEqual({ externalRef: "locations/456#description",
      readbackValue: request.value });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("/v1/accounts/123");
    expect(String(fetchImpl.mock.calls[1]![0])).toContain("/v1alpha/accounts/123/locations?readMask=name");
    expect(String(fetchImpl.mock.calls[2]![0])).toContain("/v1/locations/456?readMask=profile.description");
    expect(String(fetchImpl.mock.calls[3]![0])).toContain("updateMask=profile.description");
    expect(request.assertPrewrite).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchImpl.mock.calls[3]![1] as RequestInit).body)))
      .toEqual({ name: "locations/456", profile: { description: request.value } });
  });

  it("refuses a changed live before value without attesting or writing", async () => {
    const assertPrewrite = vi.fn();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => providerIdentity(url)
      ?? new Response(JSON.stringify({ name: "locations/456",
        profile: { description: "Someone else's edit" } }), { status: 200 }));
    await expect(patchLocationField({ ...request, assertPrewrite, fetchImpl: fetchImpl as never }))
      .rejects.toThrow(/differs from the reviewed before value/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(assertPrewrite).not.toHaveBeenCalled();
  });

  it("refuses a location absent from the reviewed account before field read or PATCH", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("accountmanagement")
        ? new Response(JSON.stringify({ name: "accounts/123" }), { status: 200 })
        : new Response(JSON.stringify({ locations: [] }), { status: 200 }));
    await expect(patchLocationField({ ...request, fetchImpl: fetchImpl as never }))
      .rejects.toThrow(/absent from the reviewed Business Profile account/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("finds the reviewed location on a later account page", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("accountmanagement")) return providerIdentity(url)!;
      if (target.includes("/v1alpha/accounts/123/locations")) {
        return new Response(JSON.stringify(target.includes("pageToken=next")
          ? { locations: [{ name: "locations/456" }] }
          : { locations: [{ name: "locations/other" }], nextPageToken: "next" }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: "locations/456", profile: {
        description: init?.method === "PATCH" || fetchImpl.mock.calls.length === 6
          ? request.value : request.currentValue,
      } }), { status: 200 });
    });
    await expect(patchLocationField({ ...request, fetchImpl: fetchImpl as never }))
      .resolves.toMatchObject({ readbackValue: request.value });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(String(fetchImpl.mock.calls[2]![0])).toContain("pageToken=next");
  });

  it("preserves additional numbers when replacing the primary phone", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return providerIdentity(url) ?? new Response(JSON.stringify(
        { name: "locations/456", phoneNumbers: {
          primaryPhone: calls.length === 3 ? "+44111" : "+44222",
          additionalPhones: ["+44333"],
        } }), { status: 200 });
    });
    await patchLocationField({ ...request, field: "primary_phone",
      currentValue: "+44111", value: "+44222", fetchImpl: fetchImpl as never });
    expect(String(fetchImpl.mock.calls[3]![0])).toContain("updateMask=phoneNumbers");
    expect(JSON.parse(String(calls[3]?.body))).toEqual({ name: "locations/456",
      phoneNumbers: { primaryPhone: "+44222", additionalPhones: ["+44333"] } });
  });

  it("rejects a field the adapter does not write before transport", async () => {
    const fetchImpl = vi.fn();
    await expect(patchLocationField({
      ...request, field: "categories", fetchImpl: fetchImpl as never,
    })).rejects.toThrow(/No adapter writes the categories/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies a network fault as retryable and a deliberate 400 as permanent", async () => {
    const unreachable = vi.fn(async (): Promise<Response> => { throw new Error("socket hang up"); });
    await expect(patchLocationField({ ...request, fetchImpl: unreachable as never }))
      .rejects.toMatchObject({ retryable: true } satisfies Partial<PlacementTransportError>);

    const refused = vi.fn(async () => new Response("bad field", { status: 400 }));
    await expect(patchLocationField({ ...request, fetchImpl: refused as never }))
      .rejects.toMatchObject({ retryable: false } satisfies Partial<PlacementTransportError>);
  });

  it("holds an uncertain PATCH response and mismatched readback", async () => {
    const before = () => new Response(JSON.stringify({ name: "locations/456",
      profile: { description: request.currentValue } }), { status: 200 });
    const uncertain = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const identity = providerIdentity(url);
      if (identity) return identity;
      if (init?.method === "PATCH") throw new Error("socket dropped");
      return before();
    });
    await expect(patchLocationField({ ...request, fetchImpl: uncertain as never }))
      .rejects.toMatchObject({ retryable: false,
        message: expect.stringContaining("outcome is uncertain") });

    const staleReadback = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      providerIdentity(url) ?? (init?.method === "PATCH"
        ? new Response(JSON.stringify({ name: "locations/456" }), { status: 200 })
        : before()));
    await expect(patchLocationField({ ...request, fetchImpl: staleReadback as never }))
      .rejects.toThrow(/readback differs/);
  });
});
