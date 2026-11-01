# B011 organic publication authority: route matrix and acceptance contract

This document describes the held migration 295 slice. It is a design and test
contract, not a statement that organic publication is operational. Production
publisher and per-client publishing switches remain off.

## Current route matrix

| Entry point | Current source of authority | Current external-write path | Required 292 outcome |
| --- | --- | --- | --- |
| `schedule_asset` from Distribution, Calendar, Assets, or Concept Workspace | Approved asset and locked same-client organic asset → brief → idea → campaign (287) | Creates a slotless `scheduled_posts` row; 287 due/claim blocks it | Preserve the calendar row and its explicit blocker. It cannot become publishable merely through a direct RPC call or asset approval. |
| `approve_slot` from the legacy Engine approval panel | `can_access_client`, asset review, transition to scheduled; no AAL2 exact outgoing decision | Creates a matching slot-backed post; 287 due/claim can select it if switches are enabled | The slot is lineage evidence only. `approve_slot` cannot constitute authority to publish; due, claim and runtime prewrite must require an exact outgoing package and canonical decision. |
| `mcp_internal.queue_distribution` | Bot distribution grant and approved asset | Inserts a scheduled post, usually without an Engine slot | Retain the row for audit; no claim or external write without the exact package and slot binding. |
| Direct service-role `scheduled_posts` insert/update | Service role bypasses RLS | Can forge a row and account/copy values; 287 requires a matching Engine slot | DB claim must deny absent or mismatched package even for service role. Runtime must independently deny before token/media signing/provider calls. |
| `publish_due` and `claim_posts_for_publishing` | 287 same-client organic lineage and one scheduled Engine slot | Service-role claim hands mutable copy and media paths to publisher | Show an exact-approval blocker until immutable package, AAL2 decision, and current state match. Do not claim on legacy or stale evidence. |
| `runPublisherJob` / `prepare` / Meta adapters | Runtime switch plus SQL claim, followed by organic route check | Signed Storage URLs and current composed copy are passed to `publish` or `publishFrame` | Require a last-moment exact package check before token access and before every provider write, including each story frame. No newly approved package may be inferred from asset approval. |

## Frozen outgoing package contract

An immutable package version binds one scheduled post to exactly one scheduled
Engine slot, one client and explicit organic campaign lineage. Its canonical
manifest records all fields that affect the provider request: platform,
provider, exact provider account ID, UTC scheduled instant, content format,
media type, ordered media objects, composed caption, first comment, alt text,
link URL, and a rights record. Each media object needs a SHA-256 of the actual
downloaded bytes, byte length, MIME type, and an immutable, private object
address that will be used by the provider fetch. A database hash of a path or
Storage metadata is not byte evidence. The package hash covers the canonical
manifest including every media byte digest and destination field.

## Migration 292 held slice

The `organic_package_builder` worker reads a scheduled post only if its one
scheduled Engine slot, approved asset, explicit organic campaign chain, copy
and currently eligible provider account all match. It downloads each `client-media`
object, hashes the actual bytes, uploads a content-addressed private copy to
`publication-media`, downloads that copy again, and verifies byte hash,
length and MIME type. The immutable package row holds the frozen object paths,
ordered byte evidence, raw and composed provider copy, exact account,
scheduled time, slot, campaign, and the asset's available rights fields. It
registers an `organic_publication` card in the unified Inbox. Matching source
shows `source_held`; changed source shows `superseded`; missing package shows
`cancelled`; expiry shows `expired`. Every card has a visible approval blocker.

`publish_due` names the exact approval hold, `claim_posts_for_publishing`
returns no posts, and `require_organic_publication_prewrite_v6` always denies.
The runtime calls that denial before credential or media URL access and again
before each provider publish or story frame. These stops include old Engine
slots and direct service-role rows. The client and runtime publishing switches
are not changed. Manual `schedule_asset` rows remain slotless and blocked;
a later manual scheduling adapter must create a matching authoritative slot
and obtain a new exact outgoing Inbox decision.

This slice does not grant an AAL2 decision, a byte-bound provider request, or
publication execution. Registration trusts the service-role package worker's
downloaded-byte measurement; it does not rehash Storage bytes inside SQL.
The source snapshot is checked again at Inbox read, but the multirow
transaction lock and exact prewrite claim are future work. A later release
must have the publisher use only the frozen `publication-media` paths and
compare its composed outgoing request against this exact package immediately
before each provider call. Story retries also need a provider idempotency and
ambiguous-outcome reconciliation contract.

An Engine slot preview from migration 277 remains blocked. The outgoing
package is a separate source/version card in the unified Approval Inbox. A
card may become decision-ready only after the bytes have been copied to an
immutable provider-facing location, verified, and the source/account/rights
snapshot is complete. If rights provenance is absent (the common generated
asset case), or an account cannot be uniquely identified, the card stays
blocked. No local `human_approved_at` or old slot approval is upgraded into a
canonical AAL2 decision.

## Required acceptance tests

1. Direct authenticated `schedule_asset` creates only a visibly blocked
   calendar row. Paid, legacy, cross-client, revoked and unknown lineage are
   rejected at schedule and claim.
2. A matching scheduled Engine slot with an approved asset and enabled client
   still has a non-null exact-package blocker and produces zero claims until a
   separate package and AAL2 Inbox decision are valid.
3. A request contains the exact current slot ID, post ID, client, campaign,
   platform, UTC instant, provider account, content format, composed copy,
   ordered media digests/lengths/MIME types, provider-facing immutable paths,
   and explicit rights evidence. Missing bytes, account, copy or rights make
   it blocked, never silently approved.
4. Repeating a request for the same source/version and same payload returns
   the same card. Reusing that version with different bytes or scope fails.
   Package rows and evidence cannot be edited, deleted or truncated.
5. Only a provisioned human reviewer with `aal2` can decide an exact package
   from its Inbox card. Stale version/hash, expired card, revoked approval,
   source edit, account change or changed media bytes fail closed.
6. The claim transaction locks and compares the live post, slot, campaign,
   asset, copy, integration and rights source to the frozen package. One
   matching approved package is required; no duplicate claim or race can
   select a changed version.
7. Runtime checks the approved package before loading a credential and
   immediately before each Meta provider call. A legacy queued job, forged
   service-role row, missing package, overwritten media object, changed copy,
   changed destination, or revoked/expired decision makes zero provider calls.
8. Story frames keep their per-frame publication ledger, and retry cannot
   send a frame twice after an ambiguous outcome. Partial publication remains
   visible for reconciliation.
9. A backfill does not fabricate approval or rights for historical assets.
   Existing rows remain visible with a blocker. The release does not change
   `PUBLISH_ENABLED`, per-client publishing settings, or provider credentials.

## Prerequisites for a decision-ready class

The existing Storage bucket is mutable to authenticated admins and service
role. A signed URL for that bucket cannot guarantee that Meta fetches the
same bytes that a reviewer saw. The provider-facing package must therefore
use a protected immutable object namespace and verify its bytes. The source
asset `usage_rights` field is nullable and has no clearance evidence for
generated media; proof rights are a separate table. A rights attestation
workflow and a source-specific AAL2 decision RPC are required before the
outgoing card can be approved. Until both exist, migration 295 must hold the
claim and show a blocker, even for legacy Engine slots that were approved.

---

*Migration numbers in this document refer to the released labels. The nineteen migrations integrated by #297 were renumbered from their original 280–298 to 283–301; references here were corrected on 1 November 2026. See `V6_MERGE_ARCHIVE_RECORD.md`.*
