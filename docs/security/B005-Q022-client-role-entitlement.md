# B005 Q022: conditional current client role entitlement

**Status: held design prototype.** Migration 296 must not be applied until Alex
chooses Q022. This branch is stacked on held migrations 280–295 and cannot be
released independently. The proposed rule is: a `client_users` row authorizes
the client console and client-sensitive data only while the same account has a
current `profiles.role = 'client'`. The row remains in place for history and
provisioning; the role is checked at every read or action.

## Decision required before release

Q022 asks whether one account may be both an employee and a client user. The
recommended answer is **separate provisioned accounts**: an employee profile
may retain a historical `client_users` row, but that row supplies no current
client entitlement. If a same-person dual role is required, design an explicit,
audited exact-client grant and its revocation rules first. Do not treat old
membership as that grant.

This migration changes authorization. Before applying it, compare production
profiles and `client_users` for accounts with non-client roles, identify any
intended dual-role users, and provision the selected replacement access. A
role change back to `client` restores an existing membership's entitlement;
that is the chosen read-time rule, not a migration-side deletion.

## Complete caller audit at the 295 head

The audit covered all migration source references to `is_client_user`, direct
`client_users` reads, `can_access_client`, and `accessible_client_ids`, plus
frontend use of `client_users`. Rows marked *central* are closed by replacing
`is_client_user`; rows marked *direct* need their own replacement in 296.

| Route | Existing caller and effect | 296 treatment |
| --- | --- | --- |
| Central client predicate | Migration 19 `is_client_user` checked only `(user_id, client_id)` | Requires current `profiles.role='client'`; `NULL` profile denies. |
| Broad client predicates | Migration 127 `can_access_client` and `accessible_client_ids` each repeated raw membership, alongside admin and active employee assignment routes | Membership branch uses `is_client_user`; admin and active assignment branches remain. |
| Core client RLS | Migration 19 `cbc_client_read`, `cpa_client_read`, `cpa_client_insert`, `ci_client_read`, `cp_client_read`, `cl_client_read`, `car_client_read`, `cai_client_read`, `cars_client_read` | Central predicate now denies employee/profileless membership. |
| Contact and sales RLS | Migration 49 `ccd_client_read`; 60 `le_client_read`; 67 `csa_client_read`, `sac_client_read`; 129 `lead_identities_client_read`, `archived_leads_client_read` | Central predicate now denies stale membership. Explicit, current sales employee grants in migration 267 remain separate. |
| Commercial, campaign, site and page RLS | Migration 72 `cc_client_read`, `cart_client_read`; 79 `cms_client_read`; 80 `csr_client_read`, `csad_client_read`; 82 `cpr_client_read`, `cpf_client_read`; 142 `client_engine_budgets_client_read` | Central predicate now denies stale membership. The policy name `cc_client_read` on campaigns is distinct from the contract policy of the same name on another table. |
| Lead/contact RPCs | Migration 267 `may_manage_client_leads` calls `is_client_user`; migration 268 `can_read_client_sales_data` and guarded reads/writes delegate to it | Stale membership no longer grants read or mutation; service, admin and explicitly approved active sales employee paths remain. |
| Proof read and upload | Migration 266 `cpa_client_insert`, `proof_obj_client_insert`, `proof_obj_client_read`; migration 294 `proof_submissions_read` | Central predicate closes client membership route. Migration 294 already required role client as a second gate; active SMM seat stays independent. |
| Client media row | Migration 05 `cma_client_read` used raw membership | Replaced by `is_client_user`; owner/assigned-employee and admin policies remain separate. |
| Contract and billing rows | Migration 07 `cc_client_read` on `client_contracts` and `cbill_client_read` on `client_billing` used raw membership | Replaced by `is_client_user`. |
| Onboarding write | Migration 272 `cos_client_update` used raw membership in both `USING` and `WITH CHECK` | Both sides use `is_client_user`, retaining the onboarding-form key condition and migration 272 identity trigger. |
| Storage contract and media read | Migration 08 `contracts_obj_client_read`, `media_obj_client_read` used raw membership from path prefix | Replaced by `is_client_user(try_uuid(folder[1]))`; separate admin and active employee owner policies remain. |
| Account team RPC | Migration 46 `my_account_team` used raw membership to choose a client's roster | Replaced by `is_client_user(ca.client_id)`; still exposes only name and category for active assignments. |
| Video client approval | Migration 175 `video_approval_state` listed raw members; `request_video_client_approval` nominated any raw member; `sign_video_approval` and `decline_video_client_approval` trusted the saved nomination | Candidate list and nomination require current client role; sign/decline recheck it; state makes old signoff false after role drift. A final-write trigger locks profile and membership rows before video approval commit. |
| Creative decision seat | Migration 247 `creative_seat_of` labelled any raw member as `client` | Requires the nominated profile's current client role. Director/SMM/admin precedence remains. |
| Membership row and frontend | Migration 01 `client_users_self_read` showed a non-client its own row; `src/context/auth.tsx` reads that row after loading `profiles` | Self-read now requires role client; frontend receives no client ID for employee/profileless accounts. Admin policy is separate. |
| Provisioning and target enumeration | Migration 11 creates initial membership; migration 286 invitation acceptance inserts it; migration 175 reads client accounts; migration 247 resolves a seat for a target user | Writes retain their contract, while target lists and seat resolution filter current role. No historical rows are deleted. |
| Bot/service paths | MCP Bot RPCs use separate active-bot and exact-client grant checks; service role bypasses RLS or follows its own guarded RPCs | No Bot grant is derived from `client_users`; service/cron route is preserved. |

## Verification and limits

`agent-runtime/src/public/client-role-entitlement.pg.test.ts` first reproduces
the existing employee plus `client_users` leak. It then applies the actual 296
SQL and checks same-client and cross-client table/Storage access, onboarding
write, sales helper, accessible-client enumeration, active employee job scope,
retirement, role drift, admin, service, anon, profileless, video nomination,
old signoff invalidation, sign/decline, and final-write denial. Related lead,
proof, creative seat, video, and retirement suites also run.

The isolated local schema replay applies all migrations through 296, resets to
released 279, upgrades through 296, resets clean, compares catalog fingerprints,
runs the two-session budget lock regression, and checks generated types. The
local database-only start excludes optional services and ignores their health
checks; it does not attest Storage HTTP behavior. Protected schema CI must also
pass at the exact PR head before any release consideration.

This prototype does not redefine employee assignment eligibility. An active
employee assignment still grants the broad `can_access_client` work scope, and
an explicit live sales employee entitlement remains governed by migration 267.
The earlier B005 work split those from client commercial membership. Any future
policy that directly joins `client_users` must use the Q022 role rule once Alex
has selected it.
