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

Migration 11 creates five named accounts only if none of their email addresses
already exists in Auth. Their passwords are **not** in this repo. With no
setting, each new account receives a different random 32-byte secret that is
never logged or returned. This includes the first admin: the operator must
establish access through a verified Supabase Auth recovery or invitation flow
controlled by the account owner. Optional per-account database settings can
supply distinct one-time bootstrap passwords of at least 16 characters:

| Setting                       | Account                                 |
| ----------------------------- | --------------------------------------- |
| `app.seed_admin_password`     | alex@attractacq.com                     |
| `app.seed_client_password`    | attractacquisition@attractacq.com       |
| `app.seed_smm_password`       | smm1@attractacq.com                     |
| `app.seed_editor_password`    | editor1@attractacq.com                  |
| `app.seed_avatar_password`    | avatar1@attractacq.com                  |

Do not pass those settings in a command line, migration file, PR, or log. A
setting must be available to the exact database session applying migration 11;
otherwise the random fallback is used. The legacy shared
`app.seed_employee_password` setting is rejected. If a named seed email already
exists, the seed block stops before any account is provisioned or promoted.
Re-running migration 11 is therefore a reviewed recovery action, not a way to
reset passwords. The restricted helper's existing-user path never rewrites
Auth passwords or metadata.

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

## Bot console logins

Migration 324 adds `profiles.is_bot` and `profiles.bot_key` and denies bot
admins on hard-hold RPCs and on admin `FOR ALL` writes. It does not create
the bot users. `create_console_user` is not the path for that.

Run the provisioner only with a service-role key, and only after a separate
CLEAR for the target project. Do not point it at staging
(`vmmertwoboqiazcsougw`) or production (`bancbdztffokwiifzoiv`) from this
change. The password is read from `BOT_USER_PASSWORD` or from stdin. It is
not accepted from an interactive prompt, not logged, and not written to disk.

```bash
BOT_PROVISION_CONFIRM=create-bot-user \
SUPABASE_URL=https://<project>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
BOT_USER_PASSWORD=<at-least-16-chars> \
node --experimental-strip-types scripts/provision-bot-user.ts \
  --bot-key bot-cos \
  --full-name "Chief of Staff"
```

`--bot-key` must be one of the keys below. The email is that mapped address.
These addresses have no mailbox. Creation sets `email_confirm: true` and
does not send confirmation, magic-link, or reset mail. Any other email and
bot_key pair is rejected.

| bot_key | email |
| --- | --- |
| `bot-cos` | `cos@attractacq.com` |
| `bot-cdm` | `delivery@attractacq.com` |
| `bot-marketing` | `marketing@attractacq.com` |
| `bot-production` | `production@attractacq.com` |
| `bot-distribution` | `distribution@attractacq.com` |
| `bot-sales` | `sales@attractacq.com` |
| `bot-admin` | `ops-admin@attractacq.com` |
| `bot-finance` | `finance@attractacq.com` |
| `bot-engineering` | `engineering@attractacq.com` |
| `bot-security` | `security@attractacq.com` |

The script calls `auth.admin.createUser` with `email_confirm` and
`app_metadata.is_bot` / `bot_key`, then inserts `profiles` (`role=admin`,
`is_bot=true`). If that insert fails, it deletes the Auth user it just
created. If the mapped email already exists, it reports the user and does
not change the password.

Password resets and MFA removal use the same script. Both refuse a profile
that is not `is_bot=true` with that `bot_key`. `--dry-run` does not write.

```bash
node --experimental-strip-types scripts/provision-bot-user.ts reset-password \
  --bot-key bot-cos
node --experimental-strip-types scripts/provision-bot-user.ts unenroll-mfa \
  --bot-key bot-cos
```

`reset-password` reads the new password from `BOT_USER_PASSWORD` or stdin
and passes it only to `auth.admin.updateUserById`. `unenroll-mfa` lists
factors with `auth.admin.mfa.listFactors` and deletes each with
`auth.admin.mfa.deleteFactor`. The same confirm, URL, and service-role
variables are required.

There is no database test job in CI. The same checks run in the agent-runtime
test suite. A local pgTAP file is `supabase/tests/bot_console_identity.sql`,
run with `supabase test db` after the migrations are applied locally.

## Local state

`.temp/` is machine-specific CLI state (project ref, service versions,
pooler URL) and is gitignored.
