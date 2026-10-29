import { describe, expect, it, vi } from "vitest";

import { applyProfileChanges, type ClaimedProfileChange } from "./updater.js";
import { locationPatchBody } from "../proof-distribution/google-business.js";
import type { RuntimeConfig } from "../config.js";
import type { AgentJobRow } from "../queue.js";

/**
 * Applying an approved profile change — G05.
 *
 * The behaviour worth pinning is what this refuses to do: write a field no
 * platform permits, write without a credential, and overwrite fields nobody
 * asked about. The last of those is the one that would quietly erase a
 * client's opening hours, and it is a property of the updateMask rather than
 * of this worker — so it is tested at the body it builds.
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

function database(claimed: ClaimedProfileChange[] = [change()], over: Record<string, unknown> = {}) {
  const events: Record<string, unknown>[] = [];
  const calls: Array<{ name: string; args: unknown }> = [];
  const rpc = vi.fn(async (name: string, args?: unknown) => {
    calls.push({ name, args });
    if (name === "claim_profile_changes") return { data: claimed, error: null };
    if (name === "integration_secret") {
      return { data: "token" in over ? over.token : "a-token", error: null };
    }
    return { data: null, error: null };
  });
  const from = vi.fn(() => ({
    insert: vi.fn(async (row: Record<string, unknown>) => {
      events.push(row);
      return { error: null };
    }),
  }));
  return { sb: { rpc, from } as never, rpc, calls, events };
}

const ok = () =>
  vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({}), { status: 200 }));

describe("the switch", () => {
  it("claims nothing when external actions are off", async () => {
    const { sb, rpc, events } = database();
    const result = await applyProfileChanges(sb, config({ campaignActionsEnabled: false }), job);
    expect(result.ok).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
    expect(String(events[0]!.description)).toMatch(/External campaign actions are off/);
  });

  it("says so when nothing is waiting on a writable field", async () => {
    const { sb, events } = database([]);
    await applyProfileChanges(sb, config(), job);
    expect(String(events[0]!.description))
      .toMatch(/No approved profile change was waiting on a field an adapter may write/);
  });
});

describe("applying one", () => {
  it("patches only the approved field, and records the reference", async () => {
    const { sb, rpc } = database();
    const fetchImpl = ok();
    await applyProfileChanges(sb, config(), job, fetchImpl as never);

    const url = String(fetchImpl.mock.calls[0]![0]);
    // Only this field is in the mask, so nothing else is touched.
    expect(url).toContain("updateMask=profile.description");
    expect(rpc).toHaveBeenCalledWith("record_profile_change_applied",
      expect.objectContaining({ p_external_ref: "accounts/123/locations/456#description" }));
  });

  it("refuses without a credential, and does not retry", async () => {
    const { sb, calls } = database([change()], { token: null });
    await applyProfileChanges(sb, config(), job, ok() as never);
    const failure = calls.find((c) => c.name === "record_profile_change_failure");
    const args = failure!.args as { p_retryable: boolean; p_reason: string };
    expect(args.p_retryable).toBe(false);
    expect(args.p_reason).toContain("no usable Google Business credential");
  });

  it("fails loudly when a surface is writable with no adapter", async () => {
    const { sb, calls } = database([change({ surface: "meta", platform: "facebook" })]);
    await applyProfileChanges(sb, config(), job, ok() as never);
    const failure = calls.find((c) => c.name === "record_profile_change_failure");
    const args = failure!.args as { p_retryable: boolean; p_reason: string };
    expect(args.p_retryable).toBe(false);
    expect(args.p_reason).toContain("although the field is marked writable");
  });

  it("treats an unreachable API as retryable and a refusal as not", async () => {
    const unreachable = vi.fn(async (): Promise<Response> => { throw new Error("socket hang up"); });
    const { sb, calls } = database();
    await applyProfileChanges(sb, config(), job, unreachable as never);
    expect((calls.find((c) => c.name === "record_profile_change_failure")!.args as
      { p_retryable: boolean }).p_retryable).toBe(true);

    const refused = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) =>
      new Response("bad field", { status: 400 }));
    const second = database();
    await applyProfileChanges(second.sb, config(), job, refused as never);
    expect((second.calls.find((c) => c.name === "record_profile_change_failure")!.args as
      { p_retryable: boolean }).p_retryable).toBe(false);
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
