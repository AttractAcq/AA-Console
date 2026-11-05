import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { UNUSABLE_CLIP_BLOCKER } from "./clip.js";

/**
 * The one string that has to be identical in two languages.
 *
 * `retry_failed_higgsfield_motion_step` matches a blocked step's blocker by
 * exact string. Migration 311 widened that match to accept the sentence this
 * runtime produces when the screen refuses a clip. So the constant here and
 * the literal there are a contract: change either alone and the recovery route
 * silently stops covering probe refusals. Silently is the problem -- nothing
 * would fail, an operator would simply find that the retry no longer applies,
 * with no error pointing at the cause.
 *
 * Reading the migration is the whole point. A test that restated the string
 * would pass while the two sides disagreed.
 */
const MIGRATION =
  "../../../../supabase/migrations/20261105030000_311_a_clip_with_no_shot_in_it_is_recoverable.sql";

describe("the blocker sentence, across TypeScript and SQL", () => {
  const sql = readFileSync(new URL(MIGRATION, import.meta.url), "utf8");

  it("appears in the migration exactly as the runtime produces it", () => {
    expect(sql).toContain(`'${UNUSABLE_CLIP_BLOCKER}'`);
  });

  it("is still accepted alongside the provider's own failure sentence", () => {
    // Widening the match must not have replaced the original case: a real
    // Higgsfield failure is the reason this route exists.
    expect(sql).toContain(
      "'Higgsfield reported a shot as failed. The request id is stored. It was not submitted again.'",
    );
  });

  it("carries no measurement, so every refusal produces the same sentence", () => {
    // A blocker that named the defect could never be matched by an equality
    // check. The measurement belongs in the job event, as `measured`.
    expect(UNUSABLE_CLIP_BLOCKER).not.toMatch(/\d/);
    expect(UNUSABLE_CLIP_BLOCKER).not.toMatch(/black|frozen|still|short|inspected/i);
  });
});
