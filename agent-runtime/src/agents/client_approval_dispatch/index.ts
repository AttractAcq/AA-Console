import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The dashboard request survives a missing provider; this job only notifies. */
export async function runClientApprovalDispatchJob(
  sb: SupabaseClient,
  config: RuntimeConfig,
  _agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  const assetId = typeof job.params?.asset_id === "string" ? job.params.asset_id : null;
  if (!assetId) return { ok: false, retryable: false, failureMessage: "No video approval request to notify." };
  const { data: request, error } = await sb.from("video_client_approval_requests")
    .select("asset_id, client_user_id, job_id, email_status, rejected_at")
    .eq("asset_id", assetId).maybeSingle();
  if (error) throw new Error(`Could not load client approval request: ${error.message}`);
  if (!request || request.job_id !== job.id || request.rejected_at) {
    return { ok: true, retryable: false }; // superseded or already declined
  }
  if (request.email_status === "sent") return { ok: true, retryable: false };

  const stamp = async (status: "sent" | "failed" | "skipped", message: string | null) => {
    const { error: updateError } = await sb.from("video_client_approval_requests")
      .update({ email_status: status, email_error: message,
        emailed_at: status === "sent" ? new Date().toISOString() : null })
      .eq("asset_id", assetId).eq("job_id", job.id);
    if (updateError) throw new Error(`Could not record notification status: ${updateError.message}`);
  };

  if (!config.resendApiKey) {
    await stamp("skipped", "No RESEND_API_KEY is set on the runtime.");
    await appendEvent(sb, job.id, "Client review is in the dashboard, but no email provider is configured.", "warn");
    return { ok: true, retryable: false };
  }

  const [{ data: profile }, { data: asset }] = await Promise.all([
    sb.from("profiles").select("email, full_name").eq("id", request.client_user_id).maybeSingle(),
    sb.from("client_media_assets").select("title, client_id").eq("id", assetId).maybeSingle(),
  ]);
  if (!profile?.email || !asset) {
    const message = "Client account has no email or the video no longer exists.";
    await stamp("failed", message);
    return { ok: true, retryable: false }; // request remains in dashboard
  }

  const safeTitle = escapeHtml(asset.title?.trim() || "your video");
  const safeName = escapeHtml(profile.full_name?.trim() || "there");
  const { data: client } = await sb.from("clients").select("name").eq("id", asset.client_id).maybeSingle();
  const safeClient = escapeHtml(client?.name ?? "your team");
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: config.resendFrom,
        to: [profile.email],
        subject: `Video ready for your review — ${asset.title?.trim() || "AA Console"}`,
        html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">
          <p>Hi ${safeName},</p><p>${safeClient} has asked you to review <strong>${safeTitle}</strong>.</p>
          <p>Watch the finished video and approve it or request changes in your dashboard.</p>
          <p><a href="${config.consoleUrl}/client/dashboard">Open your review</a></p>
          </div>`,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    const message = `Could not reach Resend: ${cause instanceof Error ? cause.message : String(cause)}`;
    await stamp("failed", message);
    return { ok: false, retryable: true, failureMessage: message };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const message = `Resend returned ${response.status}. ${detail.slice(0, 200)}`;
    await stamp("failed", message);
    return { ok: false, retryable: response.status === 429 || response.status >= 500, failureMessage: message };
  }
  await stamp("sent", null);
  await appendEvent(sb, job.id, `Emailed a video approval request to ${profile.email}.`);
  return { ok: true, retryable: false };
}
