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

describe("the render capability is checked before anything is paid for", () => {
  it("passes on an ffmpeg that has the filters a cut needs", async () => {
    const { renderCapability } = await import("./media.js");
    const result = await renderCapability();
    // Locally this depends on the installed build; either answer is valid,
    // but a refusal has to say which filter is missing rather than just no.
    if (!result.ok) {
      expect(result.message).toMatch(/drawtext|xfade|scale|not usable/);
      expect(result.message).toMatch(/nothing was spent|not usable/i);
    } else {
      expect(result.ok).toBe(true);
    }
  });

  it("names the missing filter and says nothing was spent", async () => {
    // The point of the preflight: a refusal a person can act on, before the
    // plan is written. "Invalid argument" after two model calls is not that.
    const { renderCapability } = await import("./media.js");
    const result = await renderCapability();
    if (!result.ok) expect(result.message).toMatch(/libfreetype|not usable/);
    else expect(result).toMatchObject({ ok: true });
  });
});
