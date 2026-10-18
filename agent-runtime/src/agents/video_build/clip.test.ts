import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CLIENT_MEDIA_BUCKET, CLIP_DOWNLOAD_TIMEOUT_MS, clipStoragePath, persistCompletedClip } from "./clip.js";

const CLIENT = "client-1";
const FRAME = "frame-1";
const VIDEO_URL = "https://cdn.example.test/renders/clip.mp4";
const CLIP_BYTES = Uint8Array.from([1, 2, 3, 4, 5]);

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
