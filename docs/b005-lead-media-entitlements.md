# B005: Lead RPC and client-media owner entitlements

## Existing contract and exposure

`src/App.tsx` mounts Sales OS Pipeline under the admin-only `AppShell`; the client console has its own route. Migration 19 deliberately removed assigned employees from `client_leads` reads because an editor's job scope must not grant the client's commercial pipeline. Migration 129 nevertheless made six `SECURITY DEFINER` lead RPCs depend on the broader `can_access_client` predicate. An editor with a job assignment could therefore call the RPCs directly to read stalled leads, move stages, change money or contact details, add notes, archive, and recover. The frontend route gate did not protect the RPC endpoint.

Migration 08 also let any authenticated owner read a `client-media` object forever. Migration 127 made `current_member_id` and assignment access active-member aware, but the owner policy did not call them. A retired owner could still mint a new read while the object remained present.

The current `team_category` enum has avatars, editors, SMM and creative director; it has no sales-worker entitlement. This slice therefore authorizes human lead RPCs by admin role or the existing client-user membership, and service calls by the service role. It does **not** invent a sales-employee role. A later Sales OS handoff design must add an explicit sales entitlement and tests before granting employee lead mutation.

## Migration 265

- Adds `may_manage_client_leads(uuid)` as an internal `SECURITY DEFINER` predicate. It allows service role, admin, or a client user for the target client; authenticated callers cannot execute it directly.
- Replaces the migration-129 definitions of `stalled_leads`, `advance_lead`, `update_lead`, `add_lead_note`, `archive_lead`, and `recover_lead` with the same business rules, changing their human-client predicate to `may_manage_client_leads`. It explicitly grants `service_role` execution on all six; `CREATE OR REPLACE` alone would preserve migration 129's authenticated-only grants on four of them.
- Replaces `media_obj_employee_read`: the owner must be an active employee with a current team member row and access to the client UUID in the first storage folder. Admin and client reads remain governed by their separate policies. The existing assigned-editor and SMM video policies have their own active-member checks.

The storage path remains `{client_id}/{filename}`. Paths without a UUID first segment do not receive owner access from this policy. Existing signed URLs issued before retirement may remain usable until their individual expiry; RLS governs new reads and URL issuance. Expiry/revocation of already issued bearer URLs is a separate storage-service concern.

## Verification and release boundary

`agent-runtime/src/public/lead-pipeline.pg.test.ts` applies migrations 08, 19, 127, 129 and 265 over a representative PGlite schema. It checks that an assigned editor has `can_access_client` yet cannot read the lead table or stalled RPC and cannot call any of the five mutation RPCs; an unrelated client is refused; admin and same-client user actions continue to work. A `SET ROLE service_role` test executes the stalled read and all five mutating RPCs, then verifies restored lead state and event history. The storage test checks that an owned media object is visible only for the owner's active assignment, disappears from that owner after retirement or assignment removal, and remains visible to the correct client and admin.

This local test proves the migration's behavior in the fixture. It does not establish which migrations or grants have already reached production. Before release, compare the production migration ledger and policy/function definitions with this branch, apply migrations in order through 265, then run the same role matrix against production-equivalent staging. Never treat a client UUID path or a UI route guard as the sole authorization check.

## Remaining boundary

The three console roles are not a complete identity matrix. A profile that is simultaneously an employee and linked in `client_users` inherits that explicit client membership under existing `is_client_user` policies; migration 265 preserves that rule. A future identity-matrix step must decide whether dual membership is valid and enforce the answer across all tables, RPCs and Storage policies. General team chat isolation is likewise outside this slice.
