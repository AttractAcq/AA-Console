/**
 * Rendering a carousel or a story, one frame at a time.
 *
 * Five frames is five image calls, and the failure that costs money is not
 * one job hammering the API — it is a job that renders three frames, trips a
 * 429 on the fourth, and starts again from frame one when the queue retries
 * it. That re-pays for three images that already exist.
 *
 * So storage is the progress record. Each frame is uploaded to a path
 * derived from its render and its position, and a retry renders only the
 * positions that are not there yet. It is the same rule as buildPlan in the
 * Meta work: never "do everything", always "do what is not already
 * recorded". Both are operations that cost money and can fail halfway.
 */

/** Fewer than this is not a carousel, it is two posts. */
export const MIN_FRAMES = 2;
/** Meta caps a carousel at ten, and nobody swipes that far anyway. */
export const MAX_FRAMES = 10;

/**
 * A pause between frames.
 *
 * Sequential calls space themselves out on their own, and this makes that
 * deliberate rather than incidental. It is the cheapest thing that keeps a
 * five-frame build under the rate limit, and the alternative — discovering
 * the limit and retrying — costs a whole job's latency.
 */
export const FRAME_DELAY_MS = 1_500;

export interface FrameConcept {
  position: number;
  purpose: string;
  headline: string;
  subhead: string;
  call_to_action: string;
  subject: string;
  background: string;
  visual_treatment: string;
  composition: string;
  art_direction: string;
  avoid: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Where one frame lives.
 *
 * Derived from the render and the position rather than random, because that
 * is what makes a retry able to see what already exists. A random name would
 * make every retry a fresh set of files and a fresh bill.
 */
export function framePath(
  clientId: string,
  renderId: string,
  position: number,
  extension: string,
): string {
  return `${clientId}/generated/${renderId}/${String(position).padStart(2, "0")}.${extension}`;
}

/** The position a stored frame path refers to, or null if it is not one. */
export function positionFromPath(path: string): number | null {
  const match = /\/(\d{2})\.[A-Za-z0-9]+$/.exec(path);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Which frames still need rendering.
 *
 * `done` is the set of positions already in storage. Anything planned and
 * not already there is rendered; anything already there is skipped and
 * costs nothing.
 */
export function framesToRender(
  planned: readonly FrameConcept[],
  done: ReadonlySet<number>,
): FrameConcept[] {
  return planned.filter((f) => !done.has(f.position));
}

/**
 * Why this frame plan cannot be built, or null if it can.
 *
 * Correctness only. Whether the frames are any good is taste and belongs in
 * the prompt; what is checked here is what would make the set unbuildable —
 * too few, too many, a gap in the order, or a frame with nothing to render.
 */
export function framePlanProblem(frames: readonly FrameConcept[]): string | null {
  if (frames.length < MIN_FRAMES) {
    return `A frame set needs at least ${MIN_FRAMES} frames; this one has ${frames.length}.`;
  }
  if (frames.length > MAX_FRAMES) {
    return `${MAX_FRAMES} frames is the limit; this one has ${frames.length}.`;
  }

  const seen = new Set<number>();
  for (const frame of frames) {
    if (!Number.isInteger(frame.position) || frame.position < 1) {
      return `Frame positions start at 1; got ${frame.position}.`;
    }
    if (seen.has(frame.position)) return `Two frames both claim position ${frame.position}.`;
    seen.add(frame.position);
    // A frame with no subject or background is a frame with nothing in it,
    // and the renderer would be handed a description of a blank page.
    if (!frame.subject) return `Frame ${frame.position} has no subject.`;
    if (!frame.background) return `Frame ${frame.position} has no background.`;
    if (!frame.purpose) return `Frame ${frame.position} does not say what job it does.`;
  }

  // A gap means the model skipped one, and the frames would run in an order
  // nobody chose.
  for (let i = 1; i <= frames.length; i += 1) {
    if (!seen.has(i)) return `Frame ${i} is missing; the set runs 1 to ${frames.length}.`;
  }

  return null;
}

/** What the model returned, in order, with the strings trimmed. */
export function normaliseFrames(raw: unknown): FrameConcept[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
    .map((f) => ({
      position: typeof f.position === "number" ? Math.floor(f.position) : Number.NaN,
      purpose: str(f.purpose),
      headline: str(f.headline),
      subhead: str(f.subhead),
      call_to_action: str(f.call_to_action),
      subject: str(f.subject),
      background: str(f.background),
      visual_treatment: str(f.visual_treatment),
      composition: str(f.composition),
      art_direction: str(f.art_direction),
      avoid: str(f.avoid),
    }))
    .sort((a, b) => a.position - b.position);
}

/** Sleep between frames, so the spacing is deliberate rather than incidental. */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The prompt for one frame, and where it sits in the set.
 *
 * A frame rendered with no idea of its neighbours comes back in its own
 * style, and a carousel of five unrelated pictures is not a carousel. The
 * set's art direction is repeated on every frame for that reason.
 */
export function framePrompt(frame: FrameConcept, total: number, composed: string): string {
  return `${composed}

This is frame ${frame.position} of ${total} in a set that runs together and must look like one piece of work. Its job in the set: ${frame.purpose}`;
}

export interface StoredFrame {
  position: number;
  storage_path: string;
  caption: string | null;
}

export interface RenderedBytes {
  bytes: Buffer;
  contentType: string;
  extension: string;
}

/**
 * Renders the frames that are not already stored, in order.
 *
 * Sequential on purpose. Five parallel image calls is what trips a rate
 * limit; five spaced calls is what avoids one. The delay between them makes
 * that deliberate rather than a side effect of awaiting in a loop.
 *
 * A failure part-way throws, and the frames already stored stay stored. The
 * queue retries the job, `done` is read from storage again, and only what is
 * missing is paid for a second time. That is the whole design: the cost of a
 * 429 on frame four is frame four, not frames one to four.
 */
export async function renderFrames(opts: {
  planned: readonly FrameConcept[];
  /** Positions already in storage, from listing the render's prefix. */
  done: ReadonlySet<number>;
  renderOne: (frame: FrameConcept, total: number) => Promise<RenderedBytes>;
  store: (frame: FrameConcept, rendered: RenderedBytes) => Promise<string>;
  pathFor: (frame: FrameConcept) => string;
  onProgress?: (note: string) => void;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<StoredFrame[]> {
  const total = opts.planned.length;
  const todo = framesToRender(opts.planned, opts.done);
  const delay = opts.delayMs ?? FRAME_DELAY_MS;
  const sleep = opts.sleep ?? wait;

  if (todo.length < total) {
    opts.onProgress?.(
      `Resuming: ${total - todo.length} of ${total} frames already rendered, ${todo.length} to go.`,
    );
  }

  for (const [index, frame] of todo.entries()) {
    const rendered = await opts.renderOne(frame, total);
    await opts.store(frame, rendered);
    opts.onProgress?.(`Rendered frame ${frame.position} of ${total}.`);
    // No pause after the last one: it buys nothing and delays the job.
    if (index < todo.length - 1) await sleep(delay);
  }

  return opts.planned.map((frame) => ({
    position: frame.position,
    storage_path: opts.pathFor(frame),
    caption: frame.headline || frame.subhead || null,
  }));
}

/**
 * Which production route a brief takes.
 *
 * Here rather than as a condition inside the job function, because a rule
 * living there can be deleted without a test failing — which is exactly what
 * happened the first time this was written: flipping the branch off broke
 * nothing, because nothing exercised it.
 *
 * Video never reaches this: the job refuses it earlier, since people make
 * video. So a story brief that is rendered here is an image story, and a
 * video story goes to an editor like any other video.
 */
export function buildRoute(
  mediaType: string,
  contentFormat: string,
): "text" | "image" | "frames" {
  if (mediaType !== "image") return "text";
  return contentFormat === "single" ? "image" : "frames";
}

/**
 * Why this frame set cannot be rendered, or null if it can.
 *
 * Every frame is also an image, so each faces the check a single image
 * faces. A set of text cards is the same failure five times over, and
 * finding it once the whole set is paid for is five times as expensive.
 */
export function framesConceptProblem(
  frames: readonly FrameConcept[],
  checkOne: (concept: Record<string, unknown>) => string | null,
): string | null {
  const plan = framePlanProblem(frames);
  if (plan) return plan;
  for (const frame of frames) {
    const problem = checkOne(frame as unknown as Record<string, unknown>);
    if (problem) return `Frame ${frame.position}: ${problem}`;
  }
  return null;
}
