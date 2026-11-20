import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";
import { noteComposition } from "./index.js";

it("holds an undecodable provider image before it can be filed for review", async () => {
  await expect(noteComposition({} as SupabaseClient, "job-1", Buffer.from("not image bytes"), "render"))
    .rejects.toMatchObject({
      name: "RenderError", retryable: false,
      message: "The generated frame is not a readable image. Rebuild this frame.",
    });
});
