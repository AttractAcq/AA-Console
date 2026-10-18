import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { logger } from "../logging/logger.js";
import { dispatchProofDelivery } from "./delivery.js";
export function startProofCoordinator(
  sb: SupabaseClient,
  config: RuntimeConfig,
) {
  let stopped = false,
    current: Promise<void> | null = null;
  const tick = () => {
    if (stopped || current) return;
    current = (async () => {
      try {
        const { error } = await sb.rpc("advance_proof_production");
        if (error) throw error;
      } catch {
        logger.error("proof_production_reconcile_failed", {});
      }
      try {
        await dispatchProofDelivery(sb, config);
      } catch {
        logger.error("proof_delivery_reconcile_failed", {});
      }
    })().finally(() => {
      current = null;
    });
  };
  const timer = setInterval(tick, 15000);
  timer.unref();
  tick();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await current;
    },
  };
}
