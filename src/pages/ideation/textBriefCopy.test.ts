import { expect, it } from "vitest";
import { revisedBriefBody } from "./textBriefCopy";

const old = { argument: "One.\nTwo.", script: "Original words." };
const body = "## Hook\n\nOriginal words.\n\n## Argument\n\nOne.\nTwo.\n\n## Script\n\nOriginal words.\n\n## Notes\n\nKeep this note.";
it("replaces only both matching copy sections without interpreting replacement markup", () => {
  const next = { argument: "One.\nAsk a question.", script: "Read $& and $$ literally." };
  const edited = revisedBriefBody(body, old, next);
  expect(edited).toBe("## Hook\n\nOriginal words.\n\n## Argument\n\nOne.\nAsk a question.\n\n## Script\n\nRead $& and $$ literally.\n\n## Notes\n\nKeep this note.");
  expect(revisedBriefBody(edited, next, old)).toBe(body);
});
it.each([body.replace("## Script", "## Previous script"), body + "\n\n## Script\n\nOriginal words.", body.replace("Two.", "Two. extra")])(
  "holds the edit when the stored structured copy cannot be matched uniquely", source => {
    expect(() => revisedBriefBody(source, old, old)).toThrow("saved brief body");
  });
