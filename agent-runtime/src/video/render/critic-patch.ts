import { parseRuntimeIR, type RuntimeIR } from "../validate.js";

export type IRPatch = {
  op: "set_prop" | "shorten_text" | "set_min_duration" | "set_transition";
  sceneId: string;
  path?: string;
  value: unknown;
};

type Scene = RuntimeIR["scenes"][number] & {
  narration: string;
  locked?: boolean;
  minDurationSec?: number;
};
type PatchIR = Omit<RuntimeIR, "scenes"> & { scenes: Scene[] };
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TRANSITIONS = new Set(["cut", "fade", "slideLeft", "slideUp", "wipeBrand"]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function targetAtPath(scene: Scene, path: string): {
  parent: Record<string, unknown> | unknown[]; key: string | number; current: unknown;
} {
  if (path === "narration") {
    return { parent: scene as unknown as Record<string, unknown>,
      key: "narration", current: scene.narration };
  }
  const parts = path.split(".");
  if (parts[0] !== "props" || parts.length < 2
    || parts.some((part) => !part || FORBIDDEN_KEYS.has(part))) {
    throw new Error("Critic patch path must name an existing prop or narration.");
  }
  let parent: unknown = scene.props;
  for (const part of parts.slice(1, -1)) {
    if (Array.isArray(parent)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
        throw new Error("Critic patch array index is invalid.");
      }
      parent = parent[index];
    } else {
      const record = object(parent);
      if (!record || !Object.hasOwn(record, part)) {
        throw new Error("Critic patch path does not exist.");
      }
      parent = record[part];
    }
  }
  const last = parts.at(-1)!;
  if (Array.isArray(parent)) {
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
      throw new Error("Critic patch array index is invalid.");
    }
    return { parent, key: index, current: parent[index] };
  }
  const record = object(parent);
  if (!record || !Object.hasOwn(record, last)) {
    throw new Error("Critic patch path does not exist.");
  }
  return { parent: record, key: last, current: record[last] };
}

/** Apply only edits to existing fields. Validation and the immutable input
 * protect the renderer contract; persistence must still use an exact-version
 * database transaction before a revised IR can be rendered.
 */
export function applyCriticPatch(raw: unknown, patches: IRPatch[]): {
  ir: RuntimeIR; changedSceneIds: string[]; narrationChanged: boolean;
  nextStage: "timing" | "rendering";
} {
  const ir = structuredClone(parseRuntimeIR(raw)) as PatchIR;
  if (!Array.isArray(patches) || patches.length < 1 || patches.length > 40) {
    throw new Error("Critic patch count must be between 1 and 40.");
  }
  const changed = new Set<string>();
  let narrationChanged = false;
  for (const patch of patches) {
    const scene = ir.scenes.find((item) => item.id === patch.sceneId);
    if (!scene) throw new Error("Critic patch names an unknown scene.");
    if (scene.locked) throw new Error("Critic patch cannot change a locked scene.");
    if (patch.op === "set_prop" || patch.op === "shorten_text") {
      if (typeof patch.path !== "string") throw new Error("Critic patch path is required.");
      const target = targetAtPath(scene, patch.path);
      if (patch.op === "shorten_text") {
        if (typeof target.current !== "string" || typeof patch.value !== "string"
          || patch.value.trim().length === 0
          || patch.value.length >= target.current.length) {
          throw new Error("Critic shortened text must be a shorter nonempty string.");
        }
      }
      if (patch.path === "narration" && (typeof patch.value !== "string"
        || patch.value.trim().length === 0)) {
        throw new Error("Narration patch must be nonempty text.");
      }
      if (Object.is(target.current, patch.value)) {
        throw new Error("Critic patch must change the scene.");
      }
      (target.parent as Record<string | number, unknown>)[target.key] = patch.value;
      if (patch.path === "narration") narrationChanged = true;
    } else if (patch.op === "set_min_duration") {
      if (patch.path !== undefined || typeof patch.value !== "number"
        || !Number.isFinite(patch.value) || patch.value < 2 || patch.value > 25
        || patch.value <= (scene.minDurationSec ?? 0)) {
        throw new Error("Critic minimum duration must increase within 2–25 seconds.");
      }
      scene.minDurationSec = patch.value;
    } else if (patch.op === "set_transition") {
      if (patch.path !== undefined || typeof patch.value !== "string"
        || !TRANSITIONS.has(patch.value)
        || patch.value === (scene.transitionIn ?? "cut")) {
        throw new Error("Critic transition must be a different valid transition.");
      }
      scene.transitionIn = patch.value;
    } else {
      throw new Error("Critic patch operation is not allowed.");
    }
    changed.add(scene.id);
  }
  const valid = parseRuntimeIR(ir);
  return { ir: valid, changedSceneIds: [...changed], narrationChanged,
    nextStage: narrationChanged ? "timing" : "rendering" };
}
