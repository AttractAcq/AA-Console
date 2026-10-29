# B005 migration 266: commercial reports, proof files and SOP reads

## Source and decision

Migration 265 protects lead mutations and `stalled_leads` with `may_manage_client_leads(client_id)`: service role, admin, or a user explicitly linked to that client. Five older `SECURITY DEFINER` reports still used broader `can_access_client`, which includes an active editor's job assignment or an SMM assignment. They expose lead counts, sales, cash and spend even though migration 19 removed assigned employees from the underlying lead and commercial table reads.

Migration 266 keeps the calculation and return shape of `top_content_by_revenue` from migration 62 and `acquisition_funnel`, `client_economics`, `client_economics_by_channel`, and `client_economics_by_campaign` from migration 130. It changes only their caller gate to the migration-265 helper. Service and authenticated grants remain explicit; anon and public execution remain revoked. The economics functions continue to raise `Not permitted` for unauthorized users; the SQL reports continue to return no rows. The latter difference is inherited behavior, not an indication of zero performance.

Migration 19 limited proof metadata SELECT and INSERT to a client user (with admin's separate all policy). Migration 209 later changed metadata INSERT to `can_access_client` while retaining `usage_rights='not_cleared'`; migration 08's proof Storage SELECT and INSERT also used `can_access_client`. That left proof bytes readable by an assigned editor and allowed direct employee uploads even though the admin/client `AddProofModal` is the only console upload path. Migration 266 restores metadata INSERT to client-user plus `not_cleared` and aligns both proof bucket policies to client-user. Admin retains its all policy; service-role proof capture, discovery and provider ingestion continue through trusted service paths. A client can upload only into its own `{client_id}/{proof_id}/...` folder, and cannot grant its own public-use rights during metadata insert.

Migration 08's SOP bucket read accepted a profile with `role='employee'` after retirement. Migration 266 requires `current_member_id() IS NOT NULL`, which migration 127 defines only for active members. SOPs remain team-wide for active employees and admins. The client role has no SOP read.

## Verification

`agent-runtime/src/public/lead-pipeline.pg.test.ts` runs migration 266 after migration 265 over a PGlite role fixture. It exercises all five reports with distinct Client A/B data and verifies admin, both clients, assigned editor, retired editor, service role and anon. It checks proof metadata and Storage reads and inserts for the same roles, including cross-client and `approved` rights denial. It checks SOP read while an employee is active and again after retirement. The analytics fixture uses representative spend, lead-progress and attribution relations to test authorization; it does not attempt to revalidate the reporting calculations from migrations 62, 79 and 130.

This is local evidence. Production migration state, existing proof uploads by employees, live Storage object ownership and previously issued signed URLs have not been inspected. Before release, compare the production migration ledger and live policies, assess whether any active employee workflow relies on direct proof upload, then deploy migrations in numeric order through 266 and repeat the role matrix in staging. Existing signed URLs can remain valid until expiry after a role change.

As in migration 265, `is_client_user` is based on `client_users` membership rather than `profiles.role`. A profile with both an employee record and an explicit client-user link retains that client membership. Whether such dual membership is valid belongs to the full identity-matrix decision; this slice does not silently revoke it.

## Separate lead-owner decision

`update_lead` in migration 265 accepts any active `team_members.id` as `owner_member_id`; `ProspectsLeadsPanel` also lists every active team member without client filtering. A Client A lead can therefore name a member who works only on Client B. The repository has no sales-worker category or explicit eligible-owner relation, so this migration does not guess whether owners must be assigned to that client, belong to a new sales role, or be admin users. Define that business rule, then enforce the same rule in the RPC and owner picker with same-client positive and cross-client negative tests. The owner field alone does not grant that member read access to the lead under current RLS.
