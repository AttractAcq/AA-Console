import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "./supabase";

/**
 * The same client, without the generated types.
 *
 * `src/types/database.ts` is regenerated from the database once a migration
 * has been applied, which happens after the change that needs it has been
 * reviewed. So there is always a window where a table, view or function
 * exists in a migration and not in the types, and the two ways through it
 * are to hand-edit the generated file or to cast.
 *
 * This is the cast, in one named place, because the file was partly
 * hand-written fiction once and the cure was to stop writing it by hand.
 * Everything read through here declares its own shape explicitly, so what the
 * code expects is still written down; regenerating the types replaces the
 * cast rather than the types.
 *
 * Anything using this is a candidate for deletion at the next regeneration:
 * find the callers, swap them to `supabase`, and the compiler will say
 * whether the shapes were right.
 */
export const untypedSupabase = supabase as unknown as SupabaseClient;
