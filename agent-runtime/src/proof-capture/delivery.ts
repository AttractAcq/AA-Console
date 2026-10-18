import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
export async function dispatchProofDelivery(
  sb: SupabaseClient,
  config: RuntimeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const { data: row, error } = await sb.rpc("claim_proof_delivery");
  if (error) throw error;
  if (!row?.id) return;
  let status = "failed",
    message: string | null = null,
    providerId: string | null = null;
  try {
    let response: Response;
    if (row.channel === "email") {
      if (!config.resendApiKey)
        throw new Error("Email provider is not configured.");
      response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.resendApiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `proof-request-${row.id}`,
        },
        body: JSON.stringify({
          from: config.resendFrom,
          to: [row.recipient],
          subject: row.subject,
          text: row.message,
        }),
        signal: AbortSignal.timeout(30000),
      });
    } else {
      const account = process.env.TWILIO_ACCOUNT_SID,
        secret = process.env.TWILIO_AUTH_TOKEN,
        from =
          row.channel === "whatsapp"
            ? process.env.TWILIO_WHATSAPP_FROM
            : process.env.TWILIO_SMS_FROM;
      if (!account || !secret || !from)
        throw new Error("Messaging provider is not configured.");
      if (row.channel === "whatsapp" && !row.template_sid)
        throw new Error("WhatsApp approved template is not configured.");
      const recipient =
        row.channel === "whatsapp"
          ? `whatsapp:${row.recipient}`
          : row.recipient;
      response = await fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account)}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${account}:${secret}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            From: from,
            To: recipient,
            ...(row.channel === "whatsapp"
              ? {
                  ContentSid: row.template_sid,
                  ContentVariables: JSON.stringify(row.template_variables),
                }
              : { Body: row.message }),
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
    }
    const data = (await response.json().catch(() => null)) as {
      id?: string;
      sid?: string;
      message?: string;
    } | null;
    if (response.ok) {
      providerId = data?.id ?? data?.sid ?? null;
      status = providerId ? "sent" : "uncertain";
      message = providerId
        ? null
        : "Provider accepted the request but returned no tracking ID.";
    } else {
      status = response.status >= 500 ? "uncertain" : "failed";
      message = `Provider returned HTTP ${response.status}. Check provider configuration and recipient eligibility.`;
    }
  } catch (error) {
    status =
      error instanceof Error && error.message.includes("not configured")
        ? "failed"
        : "uncertain";
    message =
      status === "failed"
        ? (error as Error).message
        : "Delivery confirmation was interrupted. Check provider history before resending.";
  }
  const { error: saveError } = await sb
    .from("proof_request_deliveries")
    .update({
      status,
      error: message,
      provider_id: providerId,
      sent_at: status === "sent" ? new Date().toISOString() : null,
      lease_until: null,
    })
    .eq("id", row.id)
    .eq("status", "sending");
  if (saveError) throw saveError;
}
