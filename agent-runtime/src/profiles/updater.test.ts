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
    expect(String(events[0]!.description)).toMatch(/last-moment prewrite verification/);
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
  const request = {
    accessToken: "test-token",
    accountRef: "accounts/123/locations/456",
    field: "description",
    value: "Approved exact description",
  };

  it("patches only one field and returns a stable external reference", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response("{}", { status: 200 }));
    const result = await patchLocationField({ ...request, fetchImpl: fetchImpl as never });
    expect(result.externalRef).toBe("accounts/123/locations/456#description");
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("updateMask=profile.description");
    expect(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)))
      .toEqual({ profile: { description: request.value } });
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
});
