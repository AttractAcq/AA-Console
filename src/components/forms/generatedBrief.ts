/**
 * What the recruitment draft endpoint returns — the brief form's own fields.
 *
 * The dialog that used to live here is now GenerateWithAIDialog, shared with
 * the campaign proposal. Only the shape stayed behind.
 */
export type GeneratedBrief = {
  title: string;
  hook: string;
  script: string;
  call_to_action: string;
  visual_direction: string;
  premise: string;
};
