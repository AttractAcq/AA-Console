# Database schema

The 28 migrations in `migrations/` are the full history of the AA Console
database, exported from the live project (`bancbdztffokwiifzoiv`) with
`supabase migration fetch`. They match what is applied there
character-for-character.

Until this export the schema existed only inside Supabase. There was
nothing to replay if the project were lost and no way to stand up a
second environment.

## Applying to a fresh project

```bash
supabase link --project-ref <ref>
supabase db push
```

## Seed accounts and passwords

Migration 11 creates the five console accounts. Their passwords are **not**
in this repo — each is read from a database setting, falling back to
`change-me`:

| Setting                       | Account                                 |
| ----------------------------- | --------------------------------------- |
| `app.seed_admin_password`     | alex@attractacq.com                     |
| `app.seed_client_password`    | attractacquisition@attractacq.com       |
| `app.seed_employee_password`  | smm1 / editor1 / avatar1                |

Set them before pushing to a new environment, or push and rotate the
passwords afterwards from the console.

Note that re-running migration 11 against an environment *without* those
settings resets the accounts to `change-me`, because `create_console_user`
keeps an existing account's password in step with what it is given. The
live project is already migrated, so this only matters for new
environments.

## Local state

`.temp/` is machine-specific CLI state (project ref, service versions,
pooler URL) and is gitignored.
