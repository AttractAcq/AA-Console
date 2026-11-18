import type { RuntimeConfig } from "../config.js";

// This is a public account/sender reference, never a credential or token.
export function proofSenderIdentity(
  channel: string,
  config: Pick<RuntimeConfig, "resendApiKey" | "resendFrom">,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (channel === "email") {
    return config.resendApiKey && config.resendFrom.trim()
      ? `resend:${config.resendFrom.trim()}`
      : null;
  }
  const account = env.TWILIO_ACCOUNT_SID?.trim();
  const secret = env.TWILIO_AUTH_TOKEN;
  const from = channel === "sms"
    ? env.TWILIO_SMS_FROM?.trim()
    : channel === "whatsapp"
      ? env.TWILIO_WHATSAPP_FROM?.trim()
      : null;
  if (!account || !secret || !from) return null;
  if (channel === "whatsapp" && !env.TWILIO_PROOF_WHATSAPP_CONTENT_SID) return null;
  return `twilio:${channel}:${account}:${from}`;
}
