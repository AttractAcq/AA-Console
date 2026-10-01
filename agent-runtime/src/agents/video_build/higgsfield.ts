/**
 * Higgsfield DoP image-to-video client.
 *
 * This is the only module that talks to platform.higgsfield.ai. Callers
 * pass a fetch implementation; tests pass a mock and never open a socket.
 * The worker constructs this only after decideMotion says the env is
 * complete. A missing key never reaches here.
 *
 * Contract, from the Cockpit DoP rules (rebuilt, not ported):
 *   POST /{model_id}  { prompt, image_url, motions: [{ id, strength }] }
 *   GET  /requests/{request_id}/status
 * Auth: Authorization: Key {api_key}:{api_key_secret}
 */

export const HIGGSFIELD_BASE_URL = "https://platform.higgsfield.ai";

const MOTION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

export class HiggsfieldError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "HiggsfieldError";
    this.retryable = retryable;
  }
}

export interface HiggsfieldMotion {
  id: string;
  strength: number;
}

export interface I2VSubmitInput {
  modelId: string;
  prompt: string;
  imageUrl: string;
  motions: HiggsfieldMotion[];
  endImageUrl?: string | null;
}

export interface I2VSubmitResult {
  requestId: string;
  status: string;
  statusUrl: string | null;
}

export interface I2VStatusResult {
  requestId: string;
  status: string;
  videoUrl: string | null;
}

export interface HiggsfieldClient {
  submitI2V(input: I2VSubmitInput): Promise<I2VSubmitResult>;
  pollStatus(requestId: string): Promise<I2VStatusResult>;
}

function modelPath(modelId: string): string {
  const trimmed = modelId.trim().replace(/^\/+/, "");
  if (!trimmed || /[\s?#]/.test(trimmed) || trimmed.includes("://") || trimmed.includes("..")) {
    throw new HiggsfieldError("Higgsfield model id is not usable.", false);
  }
  return trimmed;
}

function assertMotions(motions: HiggsfieldMotion[]): void {
  if (motions.length < 1 || motions.length > 2) {
    throw new HiggsfieldError("DoP image-to-video needs one or two motions.", false);
  }
  for (const motion of motions) {
    if (!MOTION_UUID.test(motion.id.trim())) {
      throw new HiggsfieldError("A motion id has to be a Higgsfield catalog UUID.", false);
    }
    if (!(typeof motion.strength === "number") || !Number.isFinite(motion.strength) || motion.strength <= 0) {
      throw new HiggsfieldError("Motion strength has to be a number greater than zero.", false);
    }
  }
}

function assertImageUrl(imageUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new HiggsfieldError("The opening still URL is not reachable.", false);
  }
  if (parsed.protocol !== "https:") {
    throw new HiggsfieldError("The opening still URL is not reachable.", false);
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return {};
    return body as Record<string, unknown>;
  } catch {
    return {};
  }
}

function videoUrlFrom(body: Record<string, unknown>): string | null {
  const video = body.video;
  if (video && typeof video === "object" && !Array.isArray(video)) {
    const url = (video as { url?: unknown }).url;
    if (typeof url === "string" && url.trim()) return url.trim();
  }
  const images = body.images;
  if (Array.isArray(images) && images[0] && typeof images[0] === "object") {
    const url = (images[0] as { url?: unknown }).url;
    if (typeof url === "string" && url.trim()) return url.trim();
  }
  return null;
}

export function createHiggsfieldClient(
  credentials: { apiKey: string; apiSecret: string },
  fetchImpl: typeof fetch = globalThis.fetch,
): HiggsfieldClient {
  const apiKey = credentials.apiKey.trim();
  const apiSecret = credentials.apiSecret.trim();
  if (!apiKey || !apiSecret) {
    throw new HiggsfieldError("Higgsfield credentials are missing.", false);
  }
  const authorization = `Key ${apiKey}:${apiSecret}`;

  async function call(url: string, init: { method: string; body?: string }): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.method,
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (error instanceof HiggsfieldError) throw error;
      throw new HiggsfieldError("Higgsfield could not be reached.", true);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new HiggsfieldError(`Higgsfield returned ${response.status}.`, retryable);
    }
    return readJson(response);
  }

  return {
    async submitI2V(input: I2VSubmitInput): Promise<I2VSubmitResult> {
      const prompt = input.prompt.trim();
      if (!prompt) throw new HiggsfieldError("Image-to-video needs a prompt.", false);
      assertImageUrl(input.imageUrl.trim());
      assertMotions(input.motions);
      const payload: Record<string, unknown> = {
        prompt,
        image_url: input.imageUrl.trim(),
        motions: input.motions.map((motion) => ({ id: motion.id.trim(), strength: motion.strength })),
      };
      const endImage = input.endImageUrl?.trim();
      if (endImage) {
        assertImageUrl(endImage);
        payload.end_image = endImage;
      }
      const body = await call(`${HIGGSFIELD_BASE_URL}/${modelPath(input.modelId)}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
      if (!REQUEST_ID.test(requestId)) {
        throw new HiggsfieldError("Higgsfield did not return a request id.", false);
      }
      const statusUrl = typeof body.status_url === "string" ? body.status_url : null;
      return {
        requestId,
        status: typeof body.status === "string" ? body.status : "queued",
        statusUrl,
      };
    },

    async pollStatus(requestId: string): Promise<I2VStatusResult> {
      const id = requestId.trim();
      if (!REQUEST_ID.test(id)) {
        throw new HiggsfieldError("That Higgsfield request id cannot be polled.", false);
      }
      const body = await call(`${HIGGSFIELD_BASE_URL}/requests/${id}/status`, { method: "GET" });
      return {
        requestId: id,
        status: typeof body.status === "string" ? body.status : "unknown",
        videoUrl: videoUrlFrom(body),
      };
    },
  };
}
