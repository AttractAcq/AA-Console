import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/lib/supabase.ts"), "utf8");
const clientStart = source.indexOf("createClient");
const clientEnd = source.indexOf("export async function enqueueAgentJob");
const clientSource = source.slice(clientStart, clientEnd);

const isolation =
  "Bot session isolation depends on Console keeping supabase-js sessions in localStorage (src/lib/supabase.ts). "
  + "A cookie session from @supabase/ssr or createBrowserClient, or an auth.storage / storageKey / persistSession change, "
  + "would let one browser profile share a bot login with a human Console session.";

describe("Console auth session storage", () => {
  it("keeps sessions in the supabase-js localStorage client", () => {
    expect(source, isolation).toContain('from "@supabase/supabase-js"');
    expect(source, isolation).not.toMatch(/@supabase\/ssr|createBrowserClient|createServerClient/);
    expect(clientSource, isolation).toMatch(/persistSession:\s*true/);
    expect(clientSource, isolation).not.toMatch(/\bstorage\s*:/);
    expect(clientSource, isolation).not.toMatch(/\bstorageKey\s*:/);
  });
});
