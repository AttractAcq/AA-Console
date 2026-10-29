# Read-only schema parity audit (B002)

`scripts/schema-parity.mjs` compares the current working tree's migration files
with two explicitly named PostgreSQL databases. It reads migration history and
application-owned catalog objects in `BEGIN READ ONLY` transactions. It does
not use the Supabase CLI link, `.temp/project-ref`, `db push`, `migration
repair`, or any DDL/DML. This matters because the linked project can be
production and the October history repair found migration versions that looked
pending even when the objects already existed.

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

Supabase may store a migration as several statements. The stored-statement
hash cannot generally be compared to the whole source-file hash. The report
counts source-body equivalence only if one stored statement exactly matches
the local file after trimming trailing whitespace; otherwise it says
`unverifiedRepresentationOrDifference`. Different stored SQL hashes between
staging and production are reported as a real history discrepancy, even if
their objects currently match.

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

`src/pages/admin/SchemaParityPanel.tsx` renders a validated, operator-imported
JSON report or accepts one supplied by an authorized parent view. It shows
`result`, time, Git SHA, migration heads, category status, type proof and
findings, while keeping `incomplete` and `unverified` visible. The panel does
not receive database URLs or run SQL. The auditor intentionally does not write
a result into a live database. If no authorized report is supplied, the panel
shows **Unknown**.

**B002 admin integration remains open** until the B001 admin route mounts this
panel and a trusted report artifact is served to it with timestamp and admin
access checks. Operator import makes a report reviewable, but does not prove
that it is current. The Admin route must not turn an old or missing file into a
green live status.

## Tests and limits

Run `npx vitest run scripts/schema-parity.test.mjs
src/pages/admin/SchemaParityPanel.test.tsx`. The suites check an
out-of-order/renamed migration, changed function/policy/cron definitions,
report bounds, unavailable permissions, URL redaction, and the read-only
transaction boundary, plus valid/invalid report imports and the UI's
unknown/drift states. They use fake connections and make no network calls.

This audit does not apply or repair migrations. Any correction is a separate
reviewed change under `AGENTS.md`; production migration application remains
with Alex via Chief of Staff. Full clean and upgrade replay, including a
generated-types failure gate, is B003.
