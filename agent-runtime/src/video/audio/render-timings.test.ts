import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderTimingsFromReceipts } from "./render-timings.js";

const clientId = "client";
const projectId = "project";
const irVersion = 2;
const narration = "Explain the service.";
const alignment = [
  { text: "Explain", startSec: 0.1, endSec: 0.5, loss: 0.01 },
  { text: "the", startSec: 0.55, endSec: 0.75, loss: 0.01 },
  { text: "service.", startSec: 0.8, endSec: 1.2, loss: 0.01 },
];
const sha = createHash("sha256").update(narration).digest("hex");
const audioSha = "a".repeat(64);

function fixture() {
  const scenes = [1, 2, 3].map((position) => {
    const scene_key = `s${String(position).padStart(2, "0")}`;
    const audio_path = `${clientId}/video/projects/${projectId}`
      + `/ir-v${irVersion}/scenes/${scene_key}/audio.mp3`;
    return { id: `scene-${position}`, client_id: clientId,
      project_id: projectId, scene_key, position, narration,
      audio_path, duration_sec: 2, alignment };
  });
  const receipts = scenes.map((scene) => ({ scene_id: scene.id,
    client_id: clientId, project_id: projectId, ir_version: irVersion,
    narration_sha256: sha, audio_sha256: audioSha,
    storage_path: scene.audio_path, duration_sec: 2,
    alignment, alignment_loss: 0.01 }));
  const signedMedia = scenes.map((scene) => ({ path: scene.audio_path,
    url: `https://media.example.test/${scene.scene_key}.mp3?signature=ok` }));
  return { clientId, projectId, irVersion, scenes, receipts,
    musicPath: null, musicReceipt: null, signedMedia,
    maxAlignmentLoss: 0.25 };
}

describe("exact render timings", () => {
  it("uses physical scene duration and aligned words, with optional filed music", () => {
    const input = fixture();
    const result = renderTimingsFromReceipts(input);
    expect(result.scenes.map((scene) => scene.id)).toEqual(["s01", "s02", "s03"]);
    expect(result.scenes[0]?.durationSec).toBe(2);
    expect(result.scenes[0]?.words[0]).toMatchObject({
      text: "Explain", startSec: 0.1, endSec: 0.5 });
    const musicPath = `${clientId}/video/projects/${projectId}/ir-v2/music.mp3`;
    expect(renderTimingsFromReceipts({ ...input, musicPath,
      musicReceipt: { client_id: clientId, project_id: projectId,
        ir_version: irVersion, storage_path: musicPath,
        audio_sha256: audioSha },
      signedMedia: [...input.signedMedia, { path: musicPath,
        url: "https://media.example.test/music.mp3?signature=ok" }] }).musicSrc)
      .toContain("music.mp3");
  });

  it("holds changed narration, versions, missing media and conflicting music", () => {
    const input = fixture();
    const changed = fixture();
    changed.scenes[1]!.narration = "Changed service.";
    expect(() => renderTimingsFromReceipts(changed)).toThrow(/exact scene audio receipt/);
    const stale = fixture();
    stale.receipts[2]!.ir_version = 1;
    expect(() => renderTimingsFromReceipts(stale)).toThrow(/exact scene audio receipt/);
    expect(() => renderTimingsFromReceipts({ ...input,
      signedMedia: input.signedMedia.slice(1) })).toThrow(/exact scene audio receipt/);
    expect(() => renderTimingsFromReceipts({ ...input,
      musicReceipt: { client_id: clientId, project_id: projectId,
        ir_version: 2, storage_path: "unbound", audio_sha256: audioSha } }))
      .toThrow(/music path and receipt disagree/);
  });
});
