import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Pipe Railway's variables JSON to stdin. Never print or persist credentials.
const variables = JSON.parse(readFileSync(0, "utf8"));
const key = variables.HIGGSFIELD_API_KEY;
const secret = variables.HIGGSFIELD_API_SECRET;
if (!key || !secret) throw new Error("Higgsfield credentials are unavailable");

const imageUrl = "https://raw.githubusercontent.com/AttractAcq/AA-Console/codex/v5-higgsfield-benchmark/agent-runtime/benchmarks/higgsfield/fictional-potter.png";
const variant = process.env.BENCHMARK_VARIANT === "anchored" ? "anchored" : "initial";
const prompt = variant === "anchored"
  ? "Single continuous cinematic documentary shot from the supplied opening image. The ceramic artist keeps both hands on the same unfinished terracotta vase while it turns slowly on the pottery wheel. Her fingers gently refine its rim; the vase stays on the wheel throughout. Soft window light, subtle breathing and eye movement, slow stable camera push. Preserve the exact person, hand count, natural finger anatomy, terracotta color and texture, vase silhouette, clothing, studio, and portrait framing. No lifting, finished or dark vase, cuts, text, logos, extra people, or new objects."
  : "Single continuous cinematic shot. A fictional ceramic artist in her studio lifts the same dark handmade vase shown in the opening image, turns it slowly toward soft window light, and traces one carved line with her fingertip. Natural hand and object movement, physically coherent fingers, stable facial identity, realistic clay texture, quiet documentary camera movement. Keep the vase, clothing, studio, and person's features consistent with the source image. Portrait 9:16 composition. No text, logos, cuts, extra people, or new objects.";
const models = [
  { key: "v25", id: "kling-video/v2.5-turbo/pro/image-to-video", payload: { negative_prompt: "text, subtitles, logos, distortion, morphing, static digital zoom" } },
  { key: "v30", id: "kling-video/v3.0/4k/image-to-video", payload: { sound: "off", multi_shots: false } },
];
const statePath = `/private/tmp/aa-higgsfield-compare-2026-10-12${variant === "anchored" ? "-anchored" : ""}.json`;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const auth = `Key ${key}:${secret}`;

function save() {
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

for (const model of models) {
  if (!state[model.key]?.requestId) {
    const body = { image_url: imageUrl, prompt, duration: 5, cfg_scale: 0.5, ...model.payload };
    const idempotency = createHash("sha256").update(`aa-v5-synthetic-benchmark-2026-10-12:${variant}:${model.id}:${imageUrl}:${prompt}`).digest("hex");
    const startedAt = new Date().toISOString();
    const response = await fetch(`https://api.higgsfield.ai/${model.id}`, {
      method: "POST",
      headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": idempotency },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`${model.key} submit HTTP ${response.status}`);
    const result = await response.json();
    if (typeof result.request_id !== "string") throw new Error(`${model.key} submit lacked request ID`);
    state[model.key] = { modelId: model.id, requestId: result.request_id, status: result.status, startedAt, statusUrl: result.status_url };
    save();
    process.stdout.write(`${model.key}: submitted ${result.request_id}\n`);
  }
  const record = state[model.key];
  if (!["completed", "failed", "nsfw", "canceled"].includes(record.status)) {
    const response = await fetch(record.statusUrl || `https://api.higgsfield.ai/requests/${record.requestId}/status`, {
      headers: { Authorization: auth, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`${model.key} status HTTP ${response.status}`);
    const result = await response.json();
    record.status = result.status;
    record.videoUrl = result.video?.url ?? null;
    if (["completed", "failed", "nsfw", "canceled"].includes(record.status)) record.finishedAt = new Date().toISOString();
    save();
  }
  process.stdout.write(`${model.key}: ${record.status}${record.videoUrl ? " (video ready)" : ""}\n`);
}
