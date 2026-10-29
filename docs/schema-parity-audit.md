# Read-only schema parity audit (B002)

`scripts/schema-parity.mjs` compares the current working tree's migration files
with two explicitly named PostgreSQL databases. It reads migration history and
application-owned catalog objects in `BEGIN READ ONLY` transactions. The
alternative `scripts/schema-parity-read-only-api.mjs` uses Supabase's dedicated
Management API `/database/query/read-only` endpoint for two explicit project
refs. It requires a fine-grained PAT with Database Read on only those projects
and does not send a write query. Neither mode uses the Supabase CLI link,
`.temp/project-ref`, `db push`, `migration repair`, or DDL/DML. This matters
because the linked project can be production and the October history repair
found migration versions that looked pending even when the objects existed.

## Run

Provide **two different, authorized PostgreSQL URLs** through environment
variables, preferably with database roles restricted to catalog/history reads.
For every non-loopback URL, add `sslmode=verify-full` so the connection uses
TLS and verifies the server identity. Only a disposable loopback database may
omit TLS. The auditor rejects missing/weaker remote SSL modes and two URLs
that target the same host, port and database, even if their credentials differ.
Do not put the URLs on the command line, in a shell trace, or in this report.

```bash
AA_SCHEMA_PARITY_PRODUCTION_URL='<production PostgreSQL URL?sslmode=verify-full>' \
AA_SCHEMA_PARITY_STAGING_URL='<staging PostgreSQL URL?sslmode=verify-full>' \
node scripts/schema-parity.mjs --output schema-parity.json
```

When a direct PostgreSQL connection is unavailable, create a scoped token in
Supabase with **Database Read** on the two exact projects. Do not use a legacy
full-access token in a hosted or scheduled auditor. Pass the token through an
environment variable, never a command argument:

```bash
AA_SCHEMA_PARITY_PRODUCTION_REF='<20-character production ref>' \
AA_SCHEMA_PARITY_STAGING_REF='<20-character staging ref>' \
AA_SCHEMA_PARITY_READ_TOKEN='<scoped Database Read PAT>' \
node scripts/schema-parity-read-only-api.mjs --output schema-parity.json
```

The API mode records both project refs and its read-only endpoint in the
redacted report, and compares the public/GraphQL generated schema body from
each project's Management API. Generator helper formatting is excluded; if the
schema-body boundaries are missing, type parity is `unverified`. API failures
are reduced to status/category codes without response bodies or tokens. Report
file permissions are set to `0600`.

An optional `AA_SCHEMA_PARITY_BASELINE_URL` can point to a **third, disposable
clean-replay database**. It must differ from both live URLs. With it, the
report also compares each live catalog with the replayed source state. An
optional `AA_SCHEMA_PARITY_GENERATED_TYPES_FILE` points to database types
generated from that disposable replay. The auditor compares its SHA-256 to
`src/types/database.ts`. Without that file, it reports type parity as
`unverified`; it does not infer type correctness from migration versions.

The process exits `0` for matching available snapshots, `1` for detected
drift, and `2` when one or more required reads are unavailable. A `0` without
a clean replay baseline means only that the observed staging and production
snapshots agree. It does **not** prove either matches the tracked migrations.

## What is compared

- Local migration filename versions, names, file SHA-256 values and the two
  environments' recorded versions, names and hashes of stored SQL statements.
  Locally pending and remote-only versions are listed exactly. A remote-only
  row with the same name as a locally pending file is flagged as a *possible*
  version relabel, never presumed equivalent.
- Application tables/views, columns, constraints, indexes, RLS enable/force
  flags, policies including their roles and expressions, function signatures,
  bodies and grants, triggers, event triggers, enum labels, extension versions,
  and cron schedules/commands. Catalog definitions are fingerprinted in memory.
  The report contains object identities and hashes, not SQL bodies.
- Required `pgcrypto`, `pg_cron`, `ensure_rls`, and `cron.job` presence. A
  missing permission or catalog read yields `incomplete`, not a clean result.
- The checked-in generated types hash, and an optional independently generated
  types hash. The later B003 replay gate supplies the authoritative generated
  file and CI comparison.

Supabase may store a migration as several statements or a `NULL` statements
payload. The stored-statement hash cannot generally be compared to the whole
source-file hash. The report counts source-body equivalence only if one stored
statement exactly matches the local file after trimming trailing whitespace;
otherwise it says `unverifiedRepresentationOrDifference`. The report shows
`storedSqlPayloadUnavailable` counts and never labels a `NULL` hash as an SQL
mismatch. It reports `recorded_sql_mismatch` only when both environments have
known, different stored hashes. If payloads are unavailable and no other drift
is observed, the result is `incomplete`, not a claimed match.

The JSON includes `gitSha` as **HEAD only**, plus `sourceProvenance` with
`workingTreeClean`, `migrationInputsClean`, the aggregate SHA-256 digest of
every local migration file and the generated-types file hash. A dirty or
unverifiable checkout produces `incomplete`, even if the observed database
snapshots match, so HEAD is never presented as the sole source identity.
It also includes timestamp, local/history digests, category counts,
sanitized errors, limitations, and up to 400 exact findings. `findings.total`
and `findings.omitted` disclose truncation. Connection URLs, passwords,
function bodies, migration SQL, and cron command text are never emitted.
Only the selected output file is written locally, with creation mode `0600`.

## Admin readiness integration

Admin → Schema parity now mounts `LiveSchemaParityPanel`. It calls the runtime's
`GET /admin/schema-parity` with the signed-in Supabase access token. The runtime
checks the current database-backed `profiles.role = admin` before making any
Management API call. The browser cannot choose a project, pass SQL or supply a
Management API token. The runtime uses the two configured refs and the fixed
SELECT query manifest, fingerprints function/cron definitions in memory, and
returns only a bounded redacted report. A 60-second server cache prevents
repeated page visits from exhausting the Management API rate limit; the browser
uses no cache and flags a capture older than 15 minutes as stale. Missing
credentials or malformed reports show **Unknown**. The viewer still supports
operator-imported JSON when used independently, but the Admin route uses the
trusted live feed.

Set `AA_SCHEMA_PARITY_READ_TOKEN`, `AA_SCHEMA_PARITY_PRODUCTION_REF` and
`AA_SCHEMA_PARITY_STAGING_REF` on the **agent-runtime** Railway service. Use a
fine-grained PAT that has only Database Read on the two named projects, then
check an authenticated Admin browser read and a denied non-admin read. The
current legacy Supabase CLI token must not be copied to Railway. The route is
inert until all three variables are set. The route pins both expected project
refs and requires its production ref to match the runtime's own `SUPABASE_URL`
host, so a mistaken two-project configuration cannot appear green. Changing
the staging project requires a reviewed code change to the pinned ref. It
never changes schema or data.

`scripts/schema-parity-runtime-manifest.mjs` generates the runtime's bundled
source manifest from every tracked migration, checked-in generated types and
fixed catalog query. CI and the Pages deploy run it with `--check`, so a new
migration or query edit must regenerate and commit the manifest. Railway's
runtime root directory is `/agent-runtime`, so this checked-in manifest is the
source evidence the runtime image can carry without widening the Docker build
context. The report includes the runtime's full Git SHA and the manifest's
migration/type digests. B003's clean/upgrade replay remains the stronger proof
that tracked migrations apply correctly.

The generated-types check compares both production and staging against the
checked-in public/GraphQL schema body. The aggregate status is `matching`
only when both agree; a mismatch in either environment is a named drift
finding, and an unavailable comparison is `unverified`. This prevents an
otherwise identical catalog snapshot from concealing staging type drift.

## Tests and limits

Run `npx vitest run scripts/schema-parity.test.mjs
scripts/schema-parity-read-only-api.test.mjs
src/pages/admin/SchemaParityPanel.test.tsx
src/pages/admin/LiveSchemaParityPanel.test.tsx` and the two
`agent-runtime/src/readiness/schema-parity*.test.ts` suites. They check an
out-of-order/renamed migration, changed function/policy/cron definitions,
report bounds, unavailable permissions, URL redaction, and the read-only
transaction boundary, plus valid/invalid report imports and the UI's
unknown/drift states. They use fake connections and make no network calls.

This audit does not apply or repair migrations. Any correction is a separate
reviewed change. Full clean and upgrade replay, including the generated-types
failure gate, is B003. This build does not close the live parity gate until the
scoped token is provisioned, the Admin route is verified, and staging's
observed catalog differences are reconciled.
