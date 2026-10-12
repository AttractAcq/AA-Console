import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { logger } from "../logging/logger.js";

export interface RecoveryAlert {
  alert_id: string;
  item_id: string;
  client_id: string;
  client_name: string;
  package_day: string;
  item_role: string;
  manager_email: string | null;
  reason: string;
}

export function recoveryAlertEmail(alert: RecoveryAlert, consoleUrl: string) {
  const role = alert.item_role.replace(/_/g, " ");
  return {
    to: [alert.manager_email!],
    subject: `Action needed: ${alert.client_name} ${role} for ${alert.package_day}`,
    text: [
      `${alert.client_name}'s ${role} for ${alert.package_day} has no compatible approved reserve.`,
      alert.reason,
      "The daily package remains blocked. Review the failed item and prepare an approved replacement.",
      `Open AA Console: ${consoleUrl}`,
    ].join("\n\n"),
  };
}

/** One claimed alert per tick. Resend and the DB both use stable identities. */
export async function dispatchOneRecoveryAlert(
  sb: SupabaseClient,
  config: Pick<RuntimeConfig, "resendApiKey" | "resendFrom" | "consoleUrl">,
  workerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!config.resendApiKey) return false;
  const { data, error } = await sb.rpc("claim_daily_recovery_alert", {
    p_worker: workerId, p_lease_seconds: 120,
  });
  if (error) throw new Error(`Could not claim recovery alert: ${error.message}`);
  const alert = (Array.isArray(data) ? data[0] : data) as RecoveryAlert | null;
  if (!alert) return false;
  try {
    if (!alert.manager_email) throw new Error("This client has no active SMM email address.");
    const email = recoveryAlertEmail(alert, config.consoleUrl);
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `daily-recovery/${alert.alert_id}`,
      },
      body: JSON.stringify({ from: config.resendFrom, ...email }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json() as { id?: string; message?: string };
    if (!response.ok || !body.id) throw new Error(body.message ?? `Resend returned ${response.status}.`);
    const { error: doneError } = await sb.rpc("complete_daily_recovery_alert", {
      p_alert_id: alert.alert_id, p_worker: workerId,
      p_sent: true, p_provider_message_id: body.id,
    });
    if (doneError) throw new Error(`Could not record sent alert: ${doneError.message}`);
    logger.info("daily_recovery_alert_sent", { alertId: alert.alert_id, itemId: alert.item_id });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const { error: failureError } = await sb.rpc("complete_daily_recovery_alert", {
      p_alert_id: alert.alert_id, p_worker: workerId,
      p_sent: false, p_error: message,
    });
    logger.error("daily_recovery_alert_failed", {
      alertId: alert.alert_id, error: message,
      ...(failureError ? { recordError: failureError.message } : {}),
    });
  }
  return true;
}
