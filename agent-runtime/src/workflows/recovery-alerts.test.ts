import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { dispatchOneRecoveryAlert, type RecoveryAlert } from "./recovery-alerts.js";

const alert: RecoveryAlert = {
  alert_id: "alert-1", item_id: "item-1", client_id: "client-1",
  client_name: "Example Client", package_day: "2026-10-13",
  item_role: "static_a", manager_email: "manager@example.com",
  reason: "No compatible human-approved reserve: provider failed.",
};
const config = {
  resendApiKey: "test-key", resendFrom: "AA Console <alerts@example.com>",
  consoleUrl: "https://console.example.com",
};

describe("daily recovery alert delivery", () => {
  it("claims once, sends a stable idempotency key to the assigned manager, and records the provider id", async () => {
    const rpc = vi.fn(async (name: string) => name === "claim_daily_recovery_alert"
      ? { data: [alert], error: null }
      : { data: null, error: null });
    const send = vi.fn(async () => ({ ok: true, status: 200,
      json: async () => ({ id: "resend-1" }) })) as unknown as typeof fetch;
    expect(await dispatchOneRecoveryAlert({ rpc } as unknown as SupabaseClient,
      config, "worker-1", send)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    const [, request] = vi.mocked(send).mock.calls[0]!;
    expect(request?.headers).toMatchObject({ "Idempotency-Key": "daily-recovery/alert-1" });
    const payload = JSON.parse(String(request?.body));
    expect(payload.to).toEqual(["manager@example.com"]);
    expect(payload.text).toContain("No compatible human-approved reserve");
    expect(rpc).toHaveBeenLastCalledWith("complete_daily_recovery_alert",
      { p_alert_id: "alert-1", p_worker: "worker-1", p_sent: true,
        p_provider_message_id: "resend-1" });
  });

  it("keeps the alert pending when Resend is unconfigured", async () => {
    const rpc = vi.fn();
    expect(await dispatchOneRecoveryAlert({ rpc } as unknown as SupabaseClient,
      { ...config, resendApiKey: null }, "worker-1")).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});
