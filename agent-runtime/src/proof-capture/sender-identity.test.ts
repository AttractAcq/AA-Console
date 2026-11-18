import { expect, it } from "vitest";
import { proofSenderIdentity } from "./sender-identity.js";

const email = { resendApiKey: "test-secret", resendFrom: " Proof <proof@example.invalid> " };

it("names the configured email sender without including its credential", () => {
  expect(proofSenderIdentity("email", email, {})).toBe("resend:Proof <proof@example.invalid>");
  expect(proofSenderIdentity("email", { ...email, resendApiKey: null }, {})).toBeNull();
});

it("binds Twilio channel, account and from identity", () => {
  const env = {
    TWILIO_ACCOUNT_SID: "ACexample", TWILIO_AUTH_TOKEN: "secret",
    TWILIO_SMS_FROM: "+123456789", TWILIO_WHATSAPP_FROM: "whatsapp:+123456789",
    TWILIO_PROOF_WHATSAPP_CONTENT_SID: "HXapproved",
  };
  expect(proofSenderIdentity("sms", email, env)).toBe("twilio:sms:ACexample:+123456789");
  expect(proofSenderIdentity("whatsapp", email, env)).toBe("twilio:whatsapp:ACexample:whatsapp:+123456789");
  expect(proofSenderIdentity("whatsapp", email, { ...env, TWILIO_PROOF_WHATSAPP_CONTENT_SID: "" })).toBeNull();
  expect(proofSenderIdentity("other", email, env)).toBeNull();
});
