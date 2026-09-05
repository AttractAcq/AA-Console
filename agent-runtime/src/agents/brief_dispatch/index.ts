// Emails an assigned brief to the person it was handed to.
//
// The assignment itself is already done before this runs — the job_assignments
// row is written by the console, so the work is on their dashboard whether or
// not this succeeds. This is the notification, and it is allowed to fail
// without taking the assignment with it.
//
// That split is deliberate: losing an email is an inconvenience, losing an
// assignment is losing the work.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";

const ENDPOINT = "https://api.resend.com/emails";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function body(opts: {
  memberName: string;
  clientName: string;
  briefTitle: string;
  briefBody: string;
  mediaType: string;
  dueDate: string | null;
  consoleUrl: string;
}): string {
  const due = opts.dueDate ? `<p><strong>Due:</strong> ${escapeHtml(opts.dueDate)}</p>` : "";
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.55;color:#111">
  <p>Hi ${escapeHtml(opts.memberName)},</p>
  <p>You've been assigned a new ${escapeHtml(opts.mediaType)} brief for <strong>${escapeHtml(opts.clientName)}</strong>.</p>
  <h2 style="font-size:16px;margin:20px 0 6px">${escapeHtml(opts.briefTitle)}</h2>
  ${due}
  <div style="white-space:pre-wrap;background:#f6f7f9;border-radius:8px;padding:14px;margin:12px 0">${escapeHtml(opts.briefBody)}</div>
  <p><a href="${opts.consoleUrl}/employee" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px">Open it in the console</a></p>
  <p style="color:#666;font-size:13px">It's already on your dashboard under your current work — this email is just the heads-up.</p>
</div>`;
}

export async function runBriefDispatchJob(
  sb: SupabaseClient,
  config: RuntimeConfig,
  _agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  const params = (job.params ?? {}) as Record<string, unknown>;
  const dispatchId = typeof params.dispatch_id === "string" ? params.dispatch_id : null;
  if (!dispatchId) {
    return { ok: false, retryable: false, failureMessage: "No dispatch to send." };
  }

  const { data: dispatch, error } = await sb
    .from("brief_dispatches")
    .select("id, brief_id, member_id, client_id, assignment_id, email_status")
    .eq("id", dispatchId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the dispatch: ${error.message}`);
  if (!dispatch) return { ok: false, retryable: false, failureMessage: "That dispatch no longer exists." };
  if (dispatch.email_status === "sent") {
    return { ok: true, retryable: false }; // already delivered; a retry must not double-send
  }

  const stamp = async (status: string, errorText: string | null) => {
    await sb
      .from("brief_dispatches")
      .update({
        email_status: status,
        email_error: errorText,
        emailed_at: status === "sent" ? new Date().toISOString() : null,
      })
      .eq("id", dispatchId);
  };

  if (!config.resendApiKey) {
    await stamp("skipped", "No RESEND_API_KEY is set on the runtime.");
    await appendEvent(
      sb,
      job.id,
      "No email provider configured — the brief is assigned and on their dashboard, but nothing was emailed.",
      "warn",
    );
    // Not a failure: the assignment is the work, and it landed.
    return { ok: true, retryable: false };
  }

  const [{ data: member }, { data: brief }, { data: client }, { data: assignment }] = await Promise.all([
    sb.from("team_members").select("name, user_id").eq("id", dispatch.member_id).maybeSingle(),
    sb.from("client_briefs").select("title, body, media_type").eq("id", dispatch.brief_id).maybeSingle(),
    sb.from("clients").select("name").eq("id", dispatch.client_id).maybeSingle(),
    dispatch.assignment_id
      ? sb.from("job_assignments").select("due_date").eq("id", dispatch.assignment_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  if (!member || !brief) {
    await stamp("failed", "The brief or the team member no longer exists.");
    return { ok: false, retryable: false, failureMessage: "The brief or the team member no longer exists." };
  }

  const { data: profile } = member.user_id
    ? await sb.from("profiles").select("email").eq("id", member.user_id).maybeSingle()
    : { data: null };
  const to = profile?.email;
  if (!to) {
    const message = `${member.name} has no email address on their account, so nothing could be sent.`;
    await stamp("failed", message);
    await appendEvent(sb, job.id, message, "warn");
    // The assignment still stands; this is a data gap, not a delivery fault.
    return { ok: true, retryable: false };
  }

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: config.resendFrom,
      to: [to],
      subject: `New ${brief.media_type} brief — ${brief.title}`,
      html: body({
        memberName: member.name,
        clientName: client?.name ?? "a client",
        briefTitle: brief.title,
        briefBody: brief.body ?? "",
        mediaType: brief.media_type,
        dueDate: (assignment as { due_date?: string } | null)?.due_date ?? null,
        consoleUrl: config.consoleUrl,
      }),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const message = `Resend returned ${response.status}. ${detail.slice(0, 200)}`;
    await stamp("failed", message);
    // 429 and 5xx are worth another attempt; a bad key or a rejected address
    // will fail identically forever.
    const retryable = response.status === 429 || response.status >= 500;
    return { ok: false, retryable, failureMessage: message };
  }

  await stamp("sent", null);
  await appendEvent(sb, job.id, `Emailed the brief to ${member.name}.`);
  return { ok: true, retryable: false };
}
