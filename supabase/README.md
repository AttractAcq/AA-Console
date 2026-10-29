# Database schema

`migrations/` holds the versioned AA Console schema history checked into this
repository. The files were originally exported from the live Supabase project
with `supabase migration fetch` so the schema could be reviewed and replayed.
New migrations have been added since then. From the repository root, count
the tracked SQL files at your current commit with:

```bash
git ls-files 'supabase/migrations/*.sql' | wc -l
```

The local file count does not prove which migrations are applied to a target
project. Check that project's migration history and review the pending changes
before any `supabase db push`.

## Applying to a fresh project

```bash
supabase link --project-ref <ref>
supabase db push
```

Review the pending migration list and use the approved release path. The
historical migration 11 source has a safety correction for fresh replays;
production already recorded version 11 and will not run it again on an
ordinary incremental push. See `docs/auth-fresh-replay-safety.md` before
creating a new hosted project or rebuilding from a database backup.

## Seed accounts and passwords

Migration 11 creates five named accounts. Their passwords are **not** in this
repo. With no setting, each new account receives a different random 32-byte
secret that is never logged or returned. This includes the first admin: the
operator must establish access through a verified Supabase Auth recovery or
invitation flow controlled by the account owner. An optional database setting
can supply a one-time bootstrap password of at least 16 characters:

| Setting                       | Account                                 |
| ----------------------------- | --------------------------------------- |
| `app.seed_admin_password`     | alex@attractacq.com                     |
| `app.seed_client_password`    | attractacquisition@attractacq.com       |
| `app.seed_employee_password`  | smm1 / editor1 / avatar1                |

Do not pass those settings in a command line, migration file, PR, or log. A
setting must be available to the exact database session applying migration 11;
otherwise the random fallback is used. Re-running the corrected source does
not rewrite an existing Auth password or metadata. It may still reconcile a
trusted profile and should be treated as a reviewed migration action.

## Careful: `migration fetch` overwrites migration 11

`supabase migration fetch` re-pulls **every** migration from the database and
overwrites the local files. The database still holds the original migration 11
with the five passwords as literals, so a fetch silently reverts the
parameterisation above and re-stages the plaintext admin password for commit.

After any `migration fetch`, restore it before committing:

```bash
git checkout HEAD -- supabase/migrations/20260903105742_11_auth_users_and_role_metadata.sql
```

Then confirm nothing slipped through:

```bash
git diff --cached | grep -E "^\+.*('Alex@Acq'|'AA123')"
```

## Local state

`.temp/` is machine-specific CLI state (project ref, service versions,
pooler URL) and is gitignored.
