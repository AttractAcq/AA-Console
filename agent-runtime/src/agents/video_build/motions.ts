/**
 * Higgsfield motions-catalog ids this agent may know without a catalog
 * response.
 *
 * Cockpit confirmed one DoP mapping on 2026-07-23: Zoom In. There is no
 * checked-in catalog dump, so this file hardcodes that one id and nothing
 * else. A name that is not this mapping stays unresolved. Resolving does
 * not fetch.
 */

/** Cockpit live-confirmed name. */
export const ZOOM_IN_MOTION_NAME = "Zoom In";

/** Cockpit live-confirmed catalog UUID for Zoom In. The only hardcoded id. */
export const ZOOM_IN_MOTION_ID = "fbcbec5b-30f8-4b17-ba6e-8e8d5b265562";

/**
 * What a planner may still emit when it has not been told an id.
 * Phase 1's default motion is Zoom In, so this token resolves to that id.
 */
export const MOTION_PRESET_PENDING = "pending";

export interface MotionCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  preview_url: string | null;
  start_end_frame: boolean | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResolvedMotion =
  | { ok: true; id: string; via: "phase1_default" | "sot_name" | "sot_id" | "catalog" }
  | { ok: false; preset: string };

/** "Zoom In", "zoom-in" and "zoom_in" are the same catalog name. */
export function normalizeMotionName(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/**
 * Map a shot's motion_preset onto a catalog UUID.
 *
 * Pending and Zoom In use the Cockpit id. No other id is filled in here.
 * A catalog, when the caller already has one, may confirm some other name
 * or id — that id then comes from the list.
 */
export function resolveMotionPreset(
  preset: string,
  catalog?: readonly MotionCatalogEntry[],
): ResolvedMotion {
  const trimmed = preset.trim();
  if (!trimmed) return { ok: false, preset: "" };

  const key = normalizeMotionName(trimmed);
  if (key === MOTION_PRESET_PENDING) {
    return { ok: true, id: ZOOM_IN_MOTION_ID, via: "phase1_default" };
  }
  if (key === normalizeMotionName(ZOOM_IN_MOTION_NAME)) {
    return { ok: true, id: ZOOM_IN_MOTION_ID, via: "sot_name" };
  }
  if (isUuid(trimmed) && trimmed.toLowerCase() === ZOOM_IN_MOTION_ID) {
    return { ok: true, id: ZOOM_IN_MOTION_ID, via: "sot_id" };
  }

  if (catalog) {
    const byName = catalog.find((entry) => normalizeMotionName(entry.name) === key);
    if (byName && isUuid(byName.id)) {
      return { ok: true, id: byName.id.toLowerCase(), via: "catalog" };
    }
    if (isUuid(trimmed)) {
      const byId = catalog.find((entry) => entry.id.toLowerCase() === trimmed.toLowerCase());
      if (byId && isUuid(byId.id)) {
        return { ok: true, id: byId.id.toLowerCase(), via: "catalog" };
      }
    }
  }

  return { ok: false, preset: trimmed };
}
