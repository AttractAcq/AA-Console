import { createHash } from "node:crypto";
import { sceneTimingFromAlignment, videoTimings, type SceneTiming } from "./timing.js";

type Scene = { id: string; client_id: string; project_id: string;
  scene_key: string; position: number; narration: string;
  audio_path: string | null; duration_sec: number | null;
  alignment: unknown };
type Receipt = { scene_id: string; client_id: string; project_id: string;
  ir_version: number; narration_sha256: string; audio_sha256: string;
  storage_path: string; duration_sec: number; alignment: unknown;
  alignment_loss: number };
type MusicReceipt = { client_id: string; project_id: string;
  ir_version: number; storage_path: string; audio_sha256: string };
type Media = { path: string; url: string };

const SHA = /^[0-9a-f]{64}$/;

/** Build the renderer's 30 fps timing contract from exact persisted audio receipts.
 * The caller must independently check current Storage object identities before
 * supplying signed URLs; a receipt alone cannot prove that bytes still exist.
 */
export function renderTimingsFromReceipts(input: {
  clientId: string; projectId: string; irVersion: number;
  audioVersion?: number;
  scenes: Scene[]; receipts: Receipt[];
  musicPath: string | null; musicReceipt: MusicReceipt | null;
  signedMedia: Media[]; maxAlignmentLoss: number;
}): { musicSrc: string | null; scenes: SceneTiming[] } {
  const { clientId, projectId, irVersion } = input;
  const audioVersion = input.audioVersion ?? irVersion;
  if (!clientId || !projectId || !Number.isInteger(irVersion) || irVersion < 1
    || !Number.isInteger(audioVersion) || audioVersion < 1
    || audioVersion > irVersion
    || !Number.isFinite(input.maxAlignmentLoss) || input.maxAlignmentLoss < 0
    || input.receipts.length !== input.scenes.length
    || input.scenes.length < 3 || input.scenes.length > 40) {
    throw new Error("Renderer input has an incomplete project or receipt set.");
  }
  const urls = new Map<string, string>();
  for (const media of input.signedMedia) {
    if (!media.path || urls.has(media.path)) throw new Error("Renderer media path is duplicated.");
    const parsed = new URL(media.url);
    if (parsed.protocol !== "https:" || !parsed.hostname) {
      throw new Error("Renderer media needs a signed HTTPS URL.");
    }
    urls.set(media.path, media.url);
  }
  const receipts = new Map(input.receipts.map((receipt) => [receipt.scene_id, receipt]));
  if (receipts.size !== input.receipts.length) {
    throw new Error("Renderer scene receipts are duplicated.");
  }
  const timings = input.scenes.map((scene, index) => {
    const receipt = receipts.get(scene.id);
    const expectedPath = `${clientId}/video/projects/${projectId}`
      + `/ir-v${receipt?.ir_version}/scenes/${scene.scene_key}/audio.mp3`;
    if (scene.position !== index + 1
      || scene.scene_key !== `s${String(index + 1).padStart(2, "0")}`
      || scene.client_id !== clientId || scene.project_id !== projectId
      || !receipt || receipt.scene_id !== scene.id
      || receipt.client_id !== clientId || receipt.project_id !== projectId
      || !Number.isInteger(receipt.ir_version)
      || receipt.ir_version < audioVersion || receipt.ir_version > irVersion
      || receipt.storage_path !== expectedPath || scene.audio_path !== expectedPath
      || !SHA.test(receipt.audio_sha256)
      || receipt.narration_sha256 !== createHash("sha256")
        .update(scene.narration).digest("hex")
      || Number(receipt.duration_sec) !== Number(scene.duration_sec)
      || JSON.stringify(receipt.alignment) !== JSON.stringify(scene.alignment)
      || !Array.isArray(receipt.alignment)
      || !urls.has(expectedPath)) {
      throw new Error(`${scene.scene_key}: exact scene audio receipt is unavailable.`);
    }
    return sceneTimingFromAlignment({ sceneId: scene.scene_key,
      narration: scene.narration, audioSrc: urls.get(expectedPath)!,
      audioDurationSec: Number(receipt.duration_sec),
      alignment: { words: receipt.alignment,
        loss: Number(receipt.alignment_loss) },
      maxLoss: input.maxAlignmentLoss });
  });
  let musicSrc: string | null = null;
  if (input.musicPath !== null) {
    const expectedPath = `${clientId}/video/projects/${projectId}`
      + `/ir-v${audioVersion}/music.mp3`;
    const receipt = input.musicReceipt;
    if (input.musicPath !== expectedPath || !receipt
      || receipt.client_id !== clientId || receipt.project_id !== projectId
      || receipt.ir_version !== audioVersion || receipt.storage_path !== expectedPath
      || !SHA.test(receipt.audio_sha256) || !urls.has(expectedPath)) {
      throw new Error("Renderer music receipt is unavailable.");
    }
    musicSrc = urls.get(expectedPath)!;
  } else if (input.musicReceipt !== null) {
    throw new Error("Renderer music path and receipt disagree.");
  }
  if (urls.size !== timings.length + (musicSrc ? 1 : 0)) {
    throw new Error("Renderer media includes an unbound file.");
  }
  return videoTimings(timings, musicSrc);
}
