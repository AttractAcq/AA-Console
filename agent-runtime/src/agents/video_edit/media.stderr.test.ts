import { describe, expect, it } from "vitest";
import { formatFfmpegStderr } from "./media.js";

/**
 * What a failed render tells you.
 *
 * The first real cut of a reel failed with "Task finished with error code:
 * -22" and "Nothing was written into output file" — ffmpeg's generic tail,
 * kept because the reporter took the last three lines and the cause sits
 * near the top. A diagnosis that names only the aftermath costs a deploy
 * cycle to replace with a guess.
 */
describe("a failed render names the cause, not the aftermath", () => {
  it("keeps the line that says what failed, and the tail for context", () => {
    const message = formatFfmpegStderr({
      stderr: [
        "ffmpeg version 6.1 Copyright (c) 2000-2023",
        "  Stream #0:0: Video: h264, yuv420p, 720x1280",
        "[AVFilterGraph @ 0x7a5] No such filter: 'drawtext'",
        "Error reinitializing filters!",
        "[vost#0:0/libx264 @ 0x7f8] Task finished with error code: -22 (Invalid argument)",
        "[out#0/mp4 @ 0x7f8] Nothing was written into output file, because at least one of its streams received no packets.",
      ].join("\n"),
    });
    expect(message).toMatch(/No such filter: 'drawtext'/);
    expect(message).toMatch(/Nothing was written into output file/);
  });

  it("finds a cause buried under a long configuration banner", () => {
    const message = formatFfmpegStderr({
      stderr: [
        ...Array.from({ length: 20 }, (_, i) => `  configuration line ${i}`),
        "[fc#0 @ 0x1] Error initializing filter 'xfade' with args 'offset=99'",
        "Conversion failed!",
        "[out#0/mp4 @ 0x7f8] Nothing was written into output file",
      ].join("\n"),
    });
    expect(message).toMatch(/Error initializing filter 'xfade'/);
  });

  it("does not repeat a line that is both the cause and the tail", () => {
    const message = formatFfmpegStderr({ stderr: "Unable to open file\nConversion failed!" });
    expect(message.match(/Unable to open file/g)).toHaveLength(1);
  });

  it("stays short enough to read in a job event", () => {
    const noisy = Array.from({ length: 200 }, (_, i) => `Invalid argument on line ${i}`).join("\n");
    expect(formatFfmpegStderr({ stderr: noisy }).length).toBeLessThanOrEqual(1500);
  });

  it("falls back to the error itself when ffmpeg said nothing", () => {
    expect(formatFfmpegStderr(new Error("spawn ffmpeg ENOENT"))).toBe("spawn ffmpeg ENOENT");
    expect(formatFfmpegStderr({ stderr: "   " })).toMatch(/.+/);
  });
});
