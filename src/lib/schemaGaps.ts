/**
 * Telling "this object is not in the database" apart from a real failure.
 *
 * The console deploys from CI on merge; migrations are applied separately and
 * by hand. So a panel can ship ahead of its own schema, and two have: PRs #112
 * and #113 merged and deployed while migrations 129 and 133 were never applied,
 * leaving Prospects & Leads reading `archived_leads` and Recruitment
 * Distribution reading `recruitment_meta_campaigns` — neither of which exists
 * in production.
 *
 * Treating that as a panel-wide error is wrong twice over. It throws away the
 * data that did load, and it reads to an operator as a bug in the console
 * rather than as a migration that has not been applied yet.
 *
 * A panel that uses these can name the part that is unavailable, say why, and
 * start working on its own once the migration lands — no second deploy.
 */

type PostgrestLike = { code?: string | null; message?: string | null } | null | undefined;

// 42P01 undefined_table and 42883 undefined_function come from Postgres.
// PGRST205 and PGRST202 are PostgREST's own: it answers from a schema cache,
// so a missing table is often refused before Postgres sees the request at all.
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);
const MISSING_FUNCTION_CODES = new Set(["42883", "PGRST202"]);

// The code is the reliable signal. The wording is a fallback, because which of
// the two layers answers — and therefore which code arrives — has changed
// between supabase-js releases before, and a guard that silently stops
// recognising its own case would put the panel-wide error back.
const MISSING_TABLE_TEXT = /could not find the table|relation .* does not exist/i;
const MISSING_FUNCTION_TEXT = /could not find the function|function .* does not exist/i;

function matches(error: PostgrestLike, codes: Set<string>, text: RegExp): boolean {
  if (!error) return false;
  const code = error.code?.trim();
  if (code && codes.has(code)) return true;
  return typeof error.message === "string" && text.test(error.message);
}

/** A table or view the database does not have. */
export function isMissingTable(error: PostgrestLike): boolean {
  return matches(error, MISSING_TABLE_CODES, MISSING_TABLE_TEXT);
}

/** An RPC the database does not have. */
export function isMissingFunction(error: PostgrestLike): boolean {
  return matches(error, MISSING_FUNCTION_CODES, MISSING_FUNCTION_TEXT);
}

/** Either, for a panel that does not need to tell them apart. */
export function isMissingSchemaObject(error: PostgrestLike): boolean {
  return isMissingTable(error) || isMissingFunction(error);
}

/**
 * What to show an operator. Deliberately says the console is ahead of the
 * database rather than apologising for a fault: the code is correct and the
 * remedy is a migration, which is a different person's next action.
 */
export const MIGRATION_PENDING_NOTE =
  "This part of the console is waiting on a database migration that has not been applied yet.";
