# AA Console schema parity read token

The deployed parity reader uses one **scoped Supabase personal access token** (`sbp_fc…`) on the Railway **AA-Console runtime service**. It calls the Supabase Management API read-only SQL endpoint and TypeScript types endpoint for these pinned project refs:

| Environment | Supabase project ref |
| --- | --- |
| Production | `bancbdztffokwiifzoiv` |
| Staging | `vmmertwoboqiazcsougw` |

Create the token in [Supabase Dashboard → Account → Access Tokens](https://supabase.com/dashboard/account/tokens). Name it for AA Console schema parity, give it a short expiry suitable for this acceptance work, select **only those two projects**, start from **No access**, and grant **Database → Read**. Do not choose the broad Read-only preset, Database Read-write, Migrations Read-write, or a Legacy/full-access token. The review screen should show only the intended resources and Database Read. Supabase documents that scoped tokens start with `sbp_fc`; its [permission guide](https://supabase.com/docs/guides/platform/personal-access-tokens) maps Database Read to both [read-only SQL](https://supabase.com/docs/reference/api/v1-read-only-query) and generated types. Your Supabase account role must itself permit Database Read.

The current runtime accepts **one token** for both refs. If the Dashboard cannot scope one token to exactly both projects, stop at the review screen: do not expand it to an entire organization or account just to make the current implementation work. The runtime should instead be changed to accept two separate project-scoped tokens.

The value is shown only at creation. Do not paste it into chat, Git, an `.env` file, a shell command argument, or a URL. `SUPABASE_DB_PASSWORD`, Supabase service-role keys and the CLI login token are different credentials and must not be substituted.

## Secure runtime storage after creation

In a private terminal, with Railway CLI already linked to the intended project, enter the new value invisibly and send it to Railway through stdin. The following command text contains **no token value**:

```zsh
read -rs 'aa_parity_token?Paste scoped Supabase token: '
printf '\n'
printf '%s' "$aa_parity_token" | railway variable set AA_SCHEMA_PARITY_READ_TOKEN --stdin --service 89b471e4-f3f8-4cca-8024-404ee349cb9c --environment a2687a69-f288-45cc-a9e8-9dfd78520a57 --skip-deploys
unset aa_parity_token
```

Run this only after confirming the Railway service/environment IDs in the release record. Keep the terminal private and avoid `set -x`. Tell Codex **only that the variable is set**. Codex can then set the non-secret `AA_SCHEMA_PARITY_PRODUCTION_REF` and `AA_SCHEMA_PARITY_STAGING_REF`, deploy the runtime once, and verify variable **names**, health, the signed-in parity report, and both pinned refs without printing or retrieving the token. Railway project admins can manage runtime variables; choose the narrowest applicable team access.

If the CLI reports an error, do not paste its full diagnostic if it contains the value. Report only the error code or redacted text. After the acceptance work, rotate or revoke the token according to its chosen expiry.
