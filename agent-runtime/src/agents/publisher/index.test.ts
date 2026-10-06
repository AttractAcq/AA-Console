import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { runPublisherJob, type ClaimedPost } from "./index.js";
import * as registry from "../../publishing/registry.js";
import { PublishError } from "../../publishing/types.js";

const agent = { agent_key: "publisher" } as unknown as AgentRow;
const job = { id: "job-1", params: { limit: 5 } } as unknown as AgentJobRow;
const on = { publishEnabled: true } as RuntimeConfig;
const off = { publishEnabled: false } as RuntimeConfig;

const POST: ClaimedPost = {
  post_id: "post-1",
  client_id: "client-1",
  platform: "instagram",
  provider: "instagram",
  media_type: "image",
  media_path: "assets/a.png",
  asset_id: "asset-1",
  caption: "Five steps, one chain.",
  hashtags: ["#proof"],
  alt_text: "Cards in a row.",
  link_url: null,
  first_comment: null,
  scheduled_at: "2026-10-06T09:00:00Z",
  attempt: 1,
};

function database(
  options: {
    claimed?: ClaimedPost[];
    integration?: Record<string, string | null> | null;
    token?: string | null;
    signed?: string | null;
    recordError?: string;
  } = {},
) {
  const events: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (name: string) => {
    if (name === "claim_posts_for_publishing") return { data: options.claimed ?? [POST], error: null };
    if (name === "integration_secret") {
      return { data: "token" in options ? options.token : "a-token", error: null };
    }
    if (name === "record_post_published" && options.recordError) {
      return { data: null, error: { message: options.recordError } };
    }
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    if (table === "agent_job_events") {
      return {
        insert: vi.fn(async (row: Record<string, unknown>) => {
          events.push(row);
          return { error: null };
        }),
      };
    }
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({
        data:
          "integration" in options
            ? options.integration
            : { credential_label: "17841400000000000", meta_page_id: "page_1", ad_account_id: null },
        error: null,
      }),
    });
    return chain;
  });
  const storage = {
    from: () => ({
      createSignedUrl: async () => ({
        data: { signedUrl: "signed" in options ? options.signed : "https://signed.example/a.png" },
        error: null,
      }),
    }),
  };
  return { sb: { from, rpc, storage } as unknown as SupabaseClient, rpc, events };
}

const publish = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  publish.mockResolvedValue({ ok: true, externalId: "ig_1", externalUrl: "https://ig/p/1", detail: "Published." });
  vi.spyOn(registry, "adapterFor").mockReturnValue({
    provider: "instagram",
    platforms: ["instagram"],
    accountColumn: "credential_label",
    publish,
  });
});

afterEach(() => vi.restoreAllMocks());

const failureFor = (rpc: ReturnType<typeof vi.fn>, postId: string) =>
  rpc.mock.calls.find(
    (c) => c[0] === "record_post_publish_failure" && (c[1] as { p_post_id: string }).p_post_id === postId,
  )?.[1] as { p_reason: string; p_retryable: boolean } | undefined;

describe("the switch", () => {
  it("claims nothing at all when publishing is off", async () => {
    // Not a dry run that pretends: a dry run reporting success would have
    // the database record a publication that did not happen.
    const { sb, rpc, events } = database();
    const result = await runPublisherJob(sb, off, agent, job);
    expect(result.ok).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(String(events[0]!.description)).toMatch(/Publishing is off in this runtime/);
  });
});

describe("the sweep", () => {
  it("publishes what it claimed and records it", async () => {
    const { sb, rpc } = database();
    const result = await runPublisherJob(sb, on, agent, job);
    expect(result.ok).toBe(true);

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        postId: "post-1",
        accountId: "17841400000000000",
        accessToken: "a-token",
        mediaUrl: "https://signed.example/a.png",
        mediaKind: "image",
        caption: "Five steps, one chain.\n\n#proof",
      }),
    );
    expect(rpc).toHaveBeenCalledWith(
      "record_post_published",
      expect.objectContaining({ p_post_id: "post-1", p_external_id: "ig_1", p_external_url: "https://ig/p/1" }),
    );
  });

  it("says so and stops when nothing is due", async () => {
    const { sb, events } = database({ claimed: [] });
    await runPublisherJob(sb, on, agent, job);
    expect(publish).not.toHaveBeenCalled();
    expect(String(events[0]!.description)).toMatch(/Nothing is due/);
  });

  it("does not abandon the rest of the batch when one post fails", async () => {
    // A sweep that threw on the first bad post would leave the others
    // claimed and stranded for the reaper to fail.
    const second = { ...POST, post_id: "post-2" };
    publish.mockRejectedValueOnce(new PublishError("rate limited", true));
    const { sb, rpc } = database({ claimed: [POST, second] });
    await runPublisherJob(sb, on, agent, job);

    expect(failureFor(rpc, "post-1")).toMatchObject({ p_reason: "rate limited", p_retryable: true });
    expect(rpc).toHaveBeenCalledWith("record_post_published", expect.objectContaining({ p_post_id: "post-2" }));
  });

  it("carries the adapter's verdict on whether to try again", async () => {
    publish.mockRejectedValueOnce(new PublishError("the token was revoked", false));
    const { sb, rpc } = database();
    await runPublisherJob(sb, on, agent, job);
    expect(failureFor(rpc, "post-1")!.p_retryable).toBe(false);
  });

  it("treats anything it does not recognise as not worth retrying", async () => {
    publish.mockRejectedValueOnce(new Error("something odd"));
    const { sb, rpc } = database();
    await runPublisherJob(sb, on, agent, job);
    expect(failureFor(rpc, "post-1")).toMatchObject({ p_retryable: false });
  });

  it("records a post it published but could not write down, so a person looks", async () => {
    const { sb, rpc } = database({ recordError: "deadlock" });
    await runPublisherJob(sb, on, agent, job);
    const failure = failureFor(rpc, "post-1")!;
    expect(failure.p_reason).toMatch(/Published, but could not record it/);
    expect(failure.p_retryable).toBe(false);
  });
});

describe("what stops a post before anything is sent", () => {
  it("names a platform with no adapter", async () => {
    vi.spyOn(registry, "adapterFor").mockReturnValue(null);
    const { sb, rpc } = database();
    await runPublisherJob(sb, on, agent, job);
    expect(failureFor(rpc, "post-1")).toMatchObject({
      p_reason: expect.stringContaining("no adapter for instagram"),
      p_retryable: false,
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("names an integration with no account on it", async () => {
    const { sb, rpc } = database({ integration: { credential_label: null, meta_page_id: null, ad_account_id: null } });
    await runPublisherJob(sb, on, agent, job);
    expect(failureFor(rpc, "post-1")).toMatchObject({
      p_reason: expect.stringContaining("no credential label"),
      p_retryable: false,
    });
  });

  it("names a missing credential", async () => {
    const { sb, rpc } = database({ token: null });
    await runPublisherJob(sb, on, agent, job);
    expect(failureFor(rpc, "post-1")!.p_reason).toMatch(/No usable instagram credential/);
  });

  it("retries a URL it could not sign", async () => {
    // The platform fetches this URL itself, so an unsigned one is a failure
    // before the post rather than a broken post.
    const { sb, rpc } = database({ signed: null });
    await runPublisherJob(sb, on, agent, job);
    expect(failureFor(rpc, "post-1")).toMatchObject({ p_retryable: true });
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses an asset with no file", async () => {
    const { sb, rpc } = database({ claimed: [{ ...POST, media_path: null }] });
    await runPublisherJob(sb, on, agent, job);
    expect(failureFor(rpc, "post-1")!.p_reason).toMatch(/no file to post/);
  });

  it("refuses copy that will not fit rather than truncating it", async () => {
    const { sb, rpc } = database({ claimed: [{ ...POST, caption: "a".repeat(3000) }] });
    await runPublisherJob(sb, on, agent, job);
    expect(failureFor(rpc, "post-1")!.p_reason).toMatch(/limit is 2200/);
    expect(publish).not.toHaveBeenCalled();
  });
});
