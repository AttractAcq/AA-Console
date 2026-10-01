/**
 * Whether motion may run.
 *
 * Higgsfield is submit-then-poll: POST a still and a motion id, then poll
 * the request. That client is not in this scaffold. This function decides
 * the pause and does not open a connection. Callers must not fetch
 * platform.higgsfield.ai from here — a missing key and a present key both
 * stop before any request, so a deploy cannot spend by accident.
 */

export const HIGGSFIELD_KEY_ENV = "HIGGSFIELD_API_KEY";
export const HIGGSFIELD_SECRET_ENV = "HIGGSFIELD_API_SECRET";

export interface MotionEnv {
  apiKey?: string | null;
  apiSecret?: string | null;
}

export interface MotionDecision {
  /** Always false in Phase 1. The adapter does not exist yet. */
  proceed: false;
  stage: "paused";
  retryable: false;
  reason: "missing_higgsfield_credentials" | "adapter_not_enabled";
  message: string;
}

function present(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

export function readHiggsfieldEnv(env: NodeJS.ProcessEnv = process.env): MotionEnv {
  return {
    apiKey: env[HIGGSFIELD_KEY_ENV],
    apiSecret: env[HIGGSFIELD_SECRET_ENV],
  };
}

export function decideMotion(env: MotionEnv): MotionDecision {
  const missing = [
    present(env.apiKey) ? null : HIGGSFIELD_KEY_ENV,
    present(env.apiSecret) ? null : HIGGSFIELD_SECRET_ENV,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    const listed = missing.join(" and ");
    const verb = missing.length === 1 ? "is" : "are";
    return {
      proceed: false,
      stage: "paused",
      retryable: false,
      reason: "missing_higgsfield_credentials",
      message: `Motion paused: ${listed} ${verb} not set. No Higgsfield request was sent.`,
    };
  }

  return {
    proceed: false,
    stage: "paused",
    retryable: false,
    reason: "adapter_not_enabled",
    message:
      "Motion paused: Higgsfield credentials are present, but this scaffold does not submit image-to-video. No Higgsfield request was sent.",
  };
}
