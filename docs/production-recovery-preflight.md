# Q019 production recovery preflight at released migration 279

**State:** Offline review aid only. This change does not create a production backup, run a restore, connect to either Supabase project, spend money, or authorize migration 280. The production project ref is `bancbdztffokwiifzoiv`. The released repository baseline contains exactly 296 tracked migrations through `20261030160000` (logical migration 279); held files above that marker are ignored until release. The last authenticated production readiness capture observed 18 active cron jobs. The script pins 18 source and restore job definitions, but allows a source job to be intentionally inactive at checkpoint time and requires **every disposable restore job inactive**. Review and repin the count after any released migration or cron-definition change. Production Storage object and Vault secret counts have not been measured for this recovery drill.

The existing [staging reconciliation runbook](staging-259-272-reconciliation-runbook.md) documents a temporary local restore of a staging logical dump. Its staging-only builder pins the staging ref and does not supply a durable production restore point. [Supabase backup guidance](https://supabase.com/docs/guides/platform/backups) recommends off-site CLI dumps for Free projects and says database backups exclude Storage file bytes. [Supabase CLI restore guidance](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore) requires a separate migration-history export and separately covers Storage files, Auth/Storage customizations, and target configuration. [Supabase's physical new-project restore](https://supabase.com/docs/guides/platform/clone-project) copies the Vault root key but starts copied `pg_cron`, `pg_net` and wrapper effects immediately; the source's 18 active cron jobs make an unguarded physical clone unsafe as a rehearsal target. A manual logical restore can keep those effects inactive, but [the Vault key must be migrated separately](https://supabase.com/docs/guides/database/vault#key-portability-and-migration) when encrypted secrets or columns are present.

## What the offline checker proves

`scripts/production-recovery-preflight.mjs` compares two **independently captured, private aggregate JSON snapshots**: one from production before the checkpoint and one from a separate disposable restore. Run:

```sh
node scripts/production-recovery-preflight.mjs \
  --target-ref bancbdztffokwiifzoiv \
  --source-snapshot "$PRIVATE_SOURCE_JSON" \
  --restore-snapshot "$PRIVATE_RESTORE_JSON"
```

The checker has no network imports and accepts no credential argument. It requires the explicit production ref, the matching source and restore lineage, every tracked migration version/name and stored-SQL digest/availability field, the released 279 head, client and Auth user counts plus sorted-UUID digests, Storage object/bucket counts and metadata digests, a byte manifest covering every object, Vault secret count/ID digest and successful decryption count, and all 18 cron name/definition digests. Every restored cron job must be **inactive**, including internal jobs. Unknown fields are rejected so raw SQL commands, emails and secret values cannot be accidentally incorporated into an accepted snapshot. A passing result says `offline_snapshot_consistent` and explicitly `q019Closed:false`.

The script compares declared data; it cannot authenticate that a JSON file truly came from the named Supabase project, prove that the off-site backup remains available, exercise a hosted cutover, verify a client sign-in, or prove that platform/API settings and secret stores are restorable. Record a separate trusted capture/provenance receipt and independent recovery drill before treating Q019 as satisfied. Never commit either private snapshot or any database dump, Auth row, Storage object key, cron command, Vault root key, token, or connection URL.

The Storage comparison fails separately on object count, byte count, byte-manifest digest, bucket count/configuration digest, and whole-row `storage.objects` metadata digest. Matching database rows do **not** prove object bytes were restored; matching declared byte-manifest digests do **not** prove the source metadata or access controls survived. A restore through the Storage API may create new physical row IDs or timestamps and therefore fail the whole-row metadata comparison even with identical bytes. This is an explicit review stop, not permission to suppress the failure or claim Q019. A later reviewed recovery contract may compare a canonical set of policy-relevant logical fields after demonstrating that every byte/version and access rule survived; this offline checker deliberately does not guess which metadata can be dropped. Error messages never include object paths, metadata, or digest values.

## Private snapshot contract

Use only the fields below. All `*Sha256` fields are lowercase 64-character SHA-256 digests. For an empty collection, use SHA-256 of the empty UTF-8 string, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

| Field | Source | Disposable restore | Capture rule |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | `1` | Exact schema version. |
| `projectRef`, `environment` | Production ref, `production` | A distinct target ID, `disposable` | Record actual connection/project identity; do not infer it from a filename. |
| `sourceProjectRef` | Omitted | Production ref | Explicit lineage. |
| `capturedAt` | `YYYY-MM-DDTHH:mm:ss.sssZ` UTC timestamp | Same format, after source | Capture from the operator's trusted receipt. Localized strings and offsets are rejected. |
| `migrations[]` | Full ordered `{version,name,statementsSha256}` list | Same list | Preserve SQL digest as `null` where the stored payload is unavailable; never treat `null` as byte equality to the tracked file. |
| `identities.clients`, `identities.authUsers` | `{count,idsSha256}` | Same | Hash sorted UUIDs in a private capture; never include UUIDs, emails or credentials in the JSON. |
| `storage` | `objectCount`, `objectMetadataSha256`, `bucketCount`, `bucketConfigSha256`, `byteCount`, `byteManifestSha256` | Same | Object metadata and buckets come from database; `byteCount` and byte manifest require separate Storage API export/readback. Every object/version must have a byte hash. |
| `vault` | `secretCount`, `secretIdsSha256`, `decryptableCount` | Same | Count encrypted rows and successful decryptions only; never export plaintext. If key continuity fails, this is a stop. |
| `cronJobs[]` | Exactly 18 `{name,definitionSha256,active}`; source active states may vary | Same names/digests, every `active:false` | Hash the complete schedule, SQL command, host, port, database and username privately. Do not store commands in snapshot. |

Representative read-only SQL to produce the database aggregates is below. Run each query separately through a read-only connection bound to the expected project; the aggregate collector must also record a trusted project identity from its connection context. If a query cannot run with the read-only credential, keep the fact unknown and stop. Migration 11 installs `pgcrypto` in the `extensions` schema, so the examples call `extensions.digest(...)` explicitly. This SQL does not capture Storage file bytes, Vault key, platform settings or off-site backup custody.

```sql
select version, name,
       case when statements is null then null
            else encode(extensions.digest(to_jsonb(statements)::text, 'sha256'), 'hex') end
         as "statementsSha256"
  from supabase_migrations.schema_migrations order by version;

select count(*)::int as count,
       encode(extensions.digest(coalesce(string_agg(id::text, ',' order by id), ''), 'sha256'), 'hex')
         as "idsSha256" from public.clients;
select count(*)::int as count,
       encode(extensions.digest(coalesce(string_agg(id::text, ',' order by id), ''), 'sha256'), 'hex')
         as "idsSha256" from auth.users;

select count(*)::int as "objectCount",
       encode(extensions.digest(coalesce(string_agg(to_jsonb(o)::text, E'\n'
         order by o.bucket_id, o.name, o.id::text), ''), 'sha256'), 'hex')
         as "objectMetadataSha256" from storage.objects o;
select count(*)::int as "bucketCount",
       encode(extensions.digest(coalesce(string_agg(to_jsonb(b)::text, E'\n'
         order by b.id), ''), 'sha256'), 'hex')
         as "bucketConfigSha256" from storage.buckets b;

select count(*)::int as "secretCount",
       encode(extensions.digest(coalesce(string_agg(id::text, ',' order by id), ''), 'sha256'), 'hex')
         as "secretIdsSha256" from vault.secrets;
select count(*)::int as "decryptableCount"
  from vault.decrypted_secrets where decrypted_secret is not null;

select jobname as name, active,
       encode(extensions.digest(jsonb_build_array(schedule, command, nodename, nodeport,
         database, username)::text, 'sha256'), 'hex') as "definitionSha256"
  from cron.job order by jobname;
```

For the Storage byte manifest, enumerate each current object **and version** through authorized Storage access, stream the bytes into an encrypted private destination, and compute SHA-256 per object. Store private rows as arrays `[bucket, objectName, version, byteLength, contentSha256]`, sort by the first three UTF-8 strings, serialize the array as compact UTF-8 JSON, and hash those bytes for `byteManifestSha256`. Set `byteCount` only to the number whose bytes were actually obtained and read back. A missing object, inaccessible version, zero-byte placeholder ambiguity or changed version stops the checkpoint. The same procedure on the disposable target must reproduce the digest. Store object names and contents only in the approved private backup, never in the aggregate snapshots or CI output. Because the database dump and Storage API export are separate operations, bracket both with matching read-only object inventories or hold writers during a short checkpoint window; otherwise the pair is not one consistent recovery point.

## Minimum production recovery sequence before migration 280

1. **Select custody and target.** Alex chooses an encrypted, off-site destination, key custodian, retention and a replacement/forward-repair target. Obtain the production database password or connection through an approved secret channel, plus a scoped read-only inventory credential. Do not put credentials into shell history, Git, a PR, this document or `morning_review.md`. A paid-plan change is a separate billing choice; it is not implied by this preflight.
2. **Capture fresh source evidence.** Independently read production project identity, full 296-row history through 279, client/Auth UUID digests, table/catalog fingerprints, all cron definitions, Storage object/bucket inventory and Vault count/decryptability. Compare to the latest signed-in readiness/export and the exact reviewed release manifest. Investigate any difference before a backup or SQL write.
3. **Create the encrypted off-site checkpoint.** Use a source-only Supabase CLI `db dump` for roles, application schema, application/Auth/Storage data and `supabase_migrations` schema/data. Inventory custom triggers, functions, grants and RLS policies in the managed Auth/Storage schemas separately and prove the matching tracked migrations or a reviewed diff recreates them. Export all `cron.job` definitions separately because the staging CLI cron data dump emitted zero COPY blocks despite 17 jobs. Capture Storage object **bytes** separately with a byte manifest. Re-read source identities, history, object/bucket and Vault inventories after capture; if any changed, stop and take a new consistent checkpoint. Record SHA-256, file permissions, size, source ref, capture window and the backup object's immutable location/version in a private receipt. Preserve Auth settings, API-key/service-variable version inventory, Edge Functions, Realtime settings and custom role credential re-entry procedure without copying secret values to the report.
4. **Prove restore safely.** Restore that exact checkpoint into an isolated target with external egress and writers held. Recreate cron definitions **inactive**; audit any schema/migration-created schedule and fail if one is active. If Vault secrets are present, migrate the source root key through Supabase's protected Management API or securely re-enter credentials and verify the target can decrypt all expected secrets. Restore object bytes and verify hashes. Capture the disposable snapshot and run the offline checker. Then independently verify Auth sign-in for a consented test identity, RLS/grants, essential function behavior, schema catalog, API settings and safe endpoint repoint. Do not activate a copied integration or cron as part of a drill.
5. **Record a feasible failure route.** For an additive SQL failure with intact identity/data, freeze later phases, capture actual head/catalog, rehearse the smallest data-preserving forward repair from that exact head, and review it. If data or identity is lost, use a proven hosted replacement/cutover rather than assuming a local PostgreSQL clone can serve clients. Record RPO/RTO, account/domain cutover, Railway/GitHub/Supabase secret reconfiguration, DNS/webhook callback changes, and an independent rollback decision. A hosted restore requires a deliberate effects-off gate before traffic or scheduled work.
6. **Gate each live migration.** Immediately before applying 280, reconfirm checkpoint integrity and freshness, reviewed exact SQL hash and one-version dry run. After application, read back the migration head, identities, Storage/Vault/cron invariants and release identities, then take a fresh post-write checkpoint. Keep the pre-write copy until the new recovery point and application behavior are verified. Repeat for later migrations; a local rehearsal alone never closes Q019.

The old staging-only private rehearsal bundle and any new production checkpoint are distinct. Never reuse a stale bundle or a staging identity as a production recovery receipt.
