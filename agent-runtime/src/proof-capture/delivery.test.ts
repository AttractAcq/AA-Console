import { afterEach, expect, it, vi } from "vitest";
import { dispatchProofDelivery } from "./delivery.js";
import { verifyCaptureFile } from "./files.js";
import type { RuntimeConfig } from "../config.js";
import type { SupabaseClient } from "@supabase/supabase-js";
afterEach(() => vi.unstubAllEnvs());
function db(row: unknown) {
  const update = vi.fn();
  const chain = {
    eq: () => chain,
    then: (resolve: (x: unknown) => void) =>
      Promise.resolve({ error: null }).then(resolve),
  };
  update.mockReturnValue(chain);
  return {
    sb: {
      rpc: vi.fn().mockResolvedValue({ data: row, error: null }),
      from: () => ({ update }),
    } as unknown as SupabaseClient,
    update,
  };
}
const config = {
  resendApiKey: "test",
  resendFrom: "Proof <proof@example.com>",
} as RuntimeConfig;
it("does not contact providers without an approved claim", async () => {
  const { sb } = db(null),
    send = vi.fn();
  await dispatchProofDelivery(sb, config, send);
  expect(send).not.toHaveBeenCalled();
});
it("sends a stable idempotency key and stores provider acceptance", async () => {
  const { sb, update } = db({
    id: "delivery",
    channel: "email",
    recipient: "a@example.com",
    message: "Reviewed text",
    subject: "Evidence",
  });
  const send = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ id: "provider" }), { status: 200 }),
    );
  await dispatchProofDelivery(sb, config, send);
  expect(send.mock.calls[0]![1].headers["Idempotency-Key"]).toBe(
    "proof-request-delivery",
  );
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({ status: "sent", provider_id: "provider" }),
  );
});
it("does not retry ambiguous provider failures", async () => {
  const { sb, update } = db({ id: "delivery", channel: "email" });
  await dispatchProofDelivery(
    sb,
    config,
    vi.fn().mockRejectedValue(new Error("network")),
  );
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({ status: "uncertain" }),
  );
});
it("uses the snapshotted WhatsApp template and variables", async () => {
  vi.stubEnv("TWILIO_ACCOUNT_SID", "account");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "secret");
  vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+1234567890");
  const { sb } = db({
    id: "delivery",
    channel: "whatsapp",
    recipient: "+1234567890",
    template_sid: "HXapproved",
    template_variables: { "1": "Reviewed request" },
  });
  const send = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ sid: "SMsent" })));
  await dispatchProofDelivery(sb, config, send);
  const body = send.mock.calls[0]![1].body as URLSearchParams;
  expect(body.get("ContentSid")).toBe("HXapproved");
  expect(body.has("Body")).toBe(false);
  expect(JSON.parse(body.get("ContentVariables")!)).toEqual({
    "1": "Reviewed request",
  });
});
it("rejects disguised executable attachments and empty files", () => {
  expect(
    verifyCaptureFile(Buffer.from("<script>bad</script>"), "image/png"),
  ).toBe(false);
  expect(verifyCaptureFile(Buffer.alloc(0), "application/pdf")).toBe(false);
  expect(verifyCaptureFile(Buffer.from("%PDF-1.7"), "application/pdf")).toBe(
    true,
  );
  expect(
    verifyCaptureFile(Buffer.from([26, 69, 223, 163, 0]), "audio/webm"),
  ).toBe(true);
});
