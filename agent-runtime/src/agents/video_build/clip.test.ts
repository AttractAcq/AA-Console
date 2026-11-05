import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CLIENT_MEDIA_BUCKET, CLIP_DOWNLOAD_TIMEOUT_MS, ClipStoreError, clipStoragePath, persistCompletedClip, UNUSABLE_CLIP_BLOCKER, UNUSABLE_CLIP_REASON } from "./clip.js";

const CLIENT = "client-1";
const FRAME = "frame-1";
const VIDEO_URL = "https://cdn.example.test/renders/clip.mp4";
const CLIP_BYTES = Uint8Array.from([1, 2, 3, 4, 5]);

/**
 * A clip the screen is happy with.
 *
 * These five bytes are not a video, so the real probe is not asked about them:
 * what this file tests is downloading, uploading and recording, and the screen
 * has its own tests in screen.test.ts. Passing it explicitly keeps the stub
 * visible rather than letting a test quietly skip a production step.
 */
const goodClip = vi.fn(async () => ({
  width: 1080, height: 1920, duration_sec: 5, has_video_stream: true,
  black_intervals: [], freeze_intervals: [],
}));

function storageHarness(options?: {
  uploadError?: { message: string; statusCode?: string } | null;
  removeError?: { message: string } | null;
  writeError?: { message: string } | null;
}) {
  const uploads: Array<{ bucket: string; path: string; bytes: Buffer; upsert: boolean; contentType: string }> = [];
  const removals: string[][] = [];
  const writes: Array<{ clip_path: string; id: string }> = [];
  const sb = {
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, bytes: Buffer, init: { contentType: string; upsert: boolean }) => {
            uploads.push({ bucket, path, bytes, upsert: init.upsert, contentType: init.contentType });
            return { error: options?.uploadError ?? null };
          },
          remove: async (paths: string[]) => {
            removals.push(paths);
            return { error: options?.removeError ?? null };
          },
        };
      },
    },
    from(table: string) {
      if (table !== "client_media_frames") throw new Error(`unexpected table ${table}`);
      return {
        update: (row: { clip_path: string }) => ({
          eq: async (_column: string, id: string) => {
            writes.push({ clip_path: row.clip_path, id });
            return { error: options?.writeError ?? null };
          },
        }),
      };
    },
  };
  return { sb: sb as unknown as SupabaseClient, uploads, removals, writes };
}

function clipFetch(body: BodyInit = CLIP_BYTES, status = 200) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response(body, { status, headers: { "content-type": "video/mp4" } });
  });
}

describe("persistCompletedClip", () => {
  it("downloads the completed clip, uploads it without upsert, and records clip_path", async () => {
    expect(CLIP_DOWNLOAD_TIMEOUT_MS).toBe(120_000);
    expect(clipStoragePath(CLIENT, FRAME)).toBe(`${CLIENT}/generated/clips/${FRAME}.mp4`);
    const fetchImpl = clipFetch();
    const { sb, uploads, removals, writes } = storageHarness();

    const clipPath = await persistCompletedClip(sb, {
      clientId: CLIENT,
      frameId: FRAME,
      status: "completed",
      videoUrl: VIDEO_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      probeImpl: goodClip,
    });

    expect(clipPath).toBe(`${CLIENT}/generated/clips/${FRAME}.mp4`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(VIDEO_URL);
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("platform.higgsfield.ai");
    expect(uploads).toEqual([
      {
        bucket: CLIENT_MEDIA_BUCKET,
        path: `${CLIENT}/generated/clips/${FRAME}.mp4`,
        bytes: Buffer.from(CLIP_BYTES),
        upsert: false,
        contentType: "video/mp4",
      },
    ]);
    expect(writes).toEqual([{ clip_path: `${CLIENT}/generated/clips/${FRAME}.mp4`, id: FRAME }]);
    expect(removals).toEqual([]);
  });

  describe("a clip with no shot in it", () => {
    const dead = (over: Record<string, unknown>) => vi.fn(async () => ({
      width: 1080, height: 1920, duration_sec: 5, has_video_stream: true,
      black_intervals: [], freeze_intervals: [], ...over,
    }));

    it("is not uploaded and does not get a clip_path", async () => {
      // The point of the screen. Before it, a still the model never animated
      // was stored and indexed exactly like a good shot, and nobody found out
      // until a person watched the assembled reel.
      const { sb, uploads, writes, removals } = storageHarness();
      await expect(
        persistCompletedClip(sb, {
          clientId: CLIENT,
          frameId: FRAME,
          status: "completed",
          videoUrl: VIDEO_URL,
          fetchImpl: clipFetch() as unknown as typeof fetch,
          probeImpl: dead({ freeze_intervals: [{ start_sec: 0, end_sec: 5 }] }),
        }),
      ).rejects.toThrow(UNUSABLE_CLIP_BLOCKER);
      expect(uploads).toEqual([]);
      expect(writes).toEqual([]);
      // Nothing to remove: it was refused before the upload, not after.
      expect(removals).toEqual([]);
    });

    it("is refused without being retried, because the provider already charged", async () => {
      // Re-running the job would poll the same request and download the same
      // broken bytes. Regenerating is a separate deliberate act with its own
      // single-retry budget.
      const { sb } = storageHarness();
      await persistCompletedClip(sb, {
        clientId: CLIENT,
        frameId: FRAME,
        status: "completed",
        videoUrl: VIDEO_URL,
        fetchImpl: clipFetch() as unknown as typeof fetch,
        probeImpl: dead({ black_intervals: [{ start_sec: 0, end_sec: 5 }] }),
      }).then(
        () => expect.unreachable("a black clip should be refused"),
        (error: ClipStoreError) => {
          expect(error.retryable).toBe(false);
          expect(error.reason).toBe(UNUSABLE_CLIP_REASON);
          expect(error.message).toMatch(/not stored and was not submitted again/);
        },
      );
    });

    it("fails with one constant sentence, and carries the measurement separately", async () => {
      // The blocker string has to be constant: migration 311's recovery route
      // matches a step's blocker by exact string, so a message that varied with
      // the defect could never be matched. The specific measurement rides along
      // as `detail`, which the job event logs as `measured`.
      const { sb } = storageHarness();
      await persistCompletedClip(sb, {
        clientId: CLIENT,
        frameId: FRAME,
        status: "completed",
        videoUrl: VIDEO_URL,
        fetchImpl: clipFetch() as unknown as typeof fetch,
        probeImpl: dead({ freeze_intervals: [{ start_sec: 0, end_sec: 5 }] }),
      }).then(
        () => expect.unreachable("a frozen clip should be refused"),
        (error: ClipStoreError) => {
          expect(error.message).toBe(UNUSABLE_CLIP_BLOCKER);
          expect(error.detail).toMatch(/returned a still image rather than a shot/);
        },
      );
    });

    it("is refused when it cannot be inspected at all", async () => {
      const { sb, uploads } = storageHarness();
      await expect(
        persistCompletedClip(sb, {
          clientId: CLIENT,
          frameId: FRAME,
          status: "completed",
          videoUrl: VIDEO_URL,
          fetchImpl: clipFetch() as unknown as typeof fetch,
          probeImpl: vi.fn(async () => { throw new Error("ffprobe exploded"); }),
        }),
      ).rejects.toThrow(UNUSABLE_CLIP_BLOCKER);
      expect(uploads).toEqual([]);
    });
  });

  it("does not download while the provider is still working, or when the clip is already stored", async () => {
    const fetchImpl = vi.fn();
    const { sb, uploads } = storageHarness();
    await expect(
      persistCompletedClip(sb, {
        clientId: CLIENT,
        frameId: FRAME,
        status: "in_progress",
        videoUrl: VIDEO_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        probeImpl: goodClip,
      }),
    ).resolves.toBeNull();
    await expect(
      persistCompletedClip(sb, {
        clientId: CLIENT,
        frameId: FRAME,
        status: "completed",
        videoUrl: VIDEO_URL,
        existingClipPath: "client-1/generated/clips/frame-1.mp4",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        probeImpl: goodClip,
      }),
    ).resolves.toBe("client-1/generated/clips/frame-1.mp4");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(uploads).toEqual([]);
  });

  it("removes an orphan when the upload fails, and leaves a duplicate in place", async () => {
    const failed = storageHarness({ uploadError: { message: "network broke", statusCode: "500" } });
    await expect(
      persistCompletedClip(failed.sb, {
        clientId: CLIENT,
        frameId: FRAME,
        status: "Completed",
        videoUrl: VIDEO_URL,
        fetchImpl: clipFetch() as unknown as typeof fetch,
        probeImpl: goodClip,
      }),
    ).rejects.toThrow(/Could not store the clip: network broke/);
    expect(failed.removals).toEqual([[`${CLIENT}/generated/clips/${FRAME}.mp4`]]);
    expect(failed.writes).toEqual([]);

    const duplicate = storageHarness({
      uploadError: { message: "The resource already exists", statusCode: "409" },
    });
    await expect(
      persistCompletedClip(duplicate.sb, {
        clientId: CLIENT,
        frameId: FRAME,
        status: "completed",
        videoUrl: VIDEO_URL,
        fetchImpl: clipFetch() as unknown as typeof fetch,
        probeImpl: goodClip,
      }),
    ).rejects.toThrow(/was not overwritten/);
    expect(duplicate.removals).toEqual([]);
  });

  it("removes the object when clip_path cannot be recorded", async () => {
    const { sb, removals } = storageHarness({ writeError: { message: "row missing" } });
    await expect(
      persistCompletedClip(sb, {
        clientId: CLIENT,
        frameId: FRAME,
        status: "completed",
        videoUrl: VIDEO_URL,
        fetchImpl: clipFetch() as unknown as typeof fetch,
        probeImpl: goodClip,
      }),
    ).rejects.toThrow(/Could not record clip_path/);
    expect(removals).toEqual([[`${CLIENT}/generated/clips/${FRAME}.mp4`]]);
  });

  it("refuses a non-https url and an empty clip without uploading", async () => {
    const fetchImpl = vi.fn();
    const { sb, uploads } = storageHarness();
    await expect(
      persistCompletedClip(sb, {
        clientId: CLIENT,
        frameId: FRAME,
        status: "completed",
        videoUrl: "http://cdn.example.test/clip.mp4",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        probeImpl: goodClip,
      }),
    ).rejects.toThrow(/https/);
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(
      persistCompletedClip(sb, {
        clientId: CLIENT,
        frameId: FRAME,
        status: "completed",
        videoUrl: VIDEO_URL,
        fetchImpl: clipFetch(new Uint8Array()) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/empty/);
    expect(uploads).toEqual([]);
  });
});
