/**
 * The hour a post lands on when nobody picked one.
 *
 * Mirrors `public.default_post_time()` from migration 144. The database is
 * the one that decides — a schedule written with no time gets this applied by
 * trigger, whoever wrote it — so this constant exists only so a form can show
 * the default rather than apply it silently. If the two ever disagree, the
 * database wins and the form is the thing that is wrong.
 */
export const DEFAULT_POST_TIME = "09:00";

/**
 * A time of day as the schedule RPCs take it: 24 hour, local to the client.
 *
 * Never carries a zone. The zone lives on the client, and a time that brought
 * its own would be a second opinion about which day the post is on.
 */
export function isTimeOfDay(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value);
}

/** "09:00" from an instant, in the given IANA zone. */
export function localTimeOfDay(instant: string | Date, timeZone: string): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
