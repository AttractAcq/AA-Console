import type { SupabaseClient } from "@supabase/supabase-js";
import type { AwsRegion } from "@remotion/lambda";
import type { RuntimeConfig } from "../../config.js";
import { fileProjectRenderCandidate, verifyRemoteBytes } from "./candidate.js";
import { renderProjectAspect } from "./handoff.js";
import type { VideoAspect } from "./probe.js";

type Dependencies = { render: typeof renderProjectAspect;
  file: typeof fileProjectRenderCandidate;
  verifyRemote: typeof verifyRemoteBytes };
const defaults: Dependencies = { render: renderProjectAspect,
  file: fileProjectRenderCandidate, verifyRemote: verifyRemoteBytes };

/** One aspect ends at a durable candidate receipt, never public attachment.
 * A worker retry after the receipt transaction verifies the remote bytes and
 * returns the same candidate without starting Lambda again.
 */
export async function renderAndFileProjectAspect(input: {
  sb: SupabaseClient; config: Pick<RuntimeConfig,
    "supabaseUrl" | "supabaseServiceRoleKey">;
  clientId: string; projectId: string; jobId: string;
  irVersion: number; aspect: VideoAspect;
  region: AwsRegion; functionName: string; serveUrl: string;
  localPath: string; maxAlignmentLoss: number;
}, deps: Dependencies = defaults): Promise<{ candidateId: string;
  probeResult: "pass" | "fail"; resumed: boolean }> {
  const prior = await input.sb.from("video_project_render_candidates_v1")
    .select("id,attempt_id,client_id,project_id,ir_version,aspect,storage_path,file_sha256,file_bytes,probe_result")
    .eq("client_id", input.clientId).eq("project_id", input.projectId)
    .eq("ir_version", input.irVersion).eq("aspect", input.aspect)
    .maybeSingle();
  if (prior.error) throw new Error("Prior render candidate could not be checked.");
  if (prior.data) {
    const receipt = prior.data;
    const current = await input.sb.rpc("complete_video_audio_project_v1", {
      p_project_id: input.projectId, p_ir_version: input.irVersion });
    if (current.error || current.data !== true) {
      throw new Error("Prior render candidate source is no longer current.");
    }
    const attemptResult = await input.sb.from("video_project_render_attempts_v1")
      .select("id,job_id,state").eq("id", receipt.attempt_id)
      .eq("client_id", input.clientId).maybeSingle();
    if (attemptResult.error || !attemptResult.data
      || attemptResult.data.job_id !== input.jobId
      || attemptResult.data.state !== (receipt.probe_result === "pass"
        ? "succeeded" : "failed")) {
      throw new Error("Prior candidate is not bound to this render job.");
    }
    await deps.verifyRemote({ sb: input.sb,
      storagePath: receipt.storage_path,
      sha256: receipt.file_sha256,
      size: Number(receipt.file_bytes) });
    return { candidateId: receipt.id,
      probeResult: receipt.probe_result as "pass" | "fail", resumed: true };
  }
  const rendered = await deps.render(input);
  const candidateId = await deps.file({ sb: input.sb, config: input.config,
    clientId: input.clientId, projectId: input.projectId,
    jobId: input.jobId, attemptId: rendered.attemptId,
    irVersion: input.irVersion, aspect: input.aspect,
    outputPath: rendered.outputPath, probe: rendered.probe });
  return { candidateId, probeResult: rendered.probe.result, resumed: false };
}
