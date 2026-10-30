# Proof capture submission read boundary (held migration 294)

Migration 216 gave every authenticated `can_access_client(client_id)` caller
direct `SELECT` access to `proof_capture_submissions`. That helper includes
active creative and job assignments. The table contains a submitter's name,
job reference and the exact consent statement, so an assigned editor could
read personal evidence that their production job does not require.

Migration 294 changes only that table's read policy. It remains a held,
unapplied migration in the 280–294 stack. No external switch or proof delivery
route is enabled by this change.

| Caller at read time | Submission rows after 294 | Reason |
| --- | --- | --- |
| Provisioned administrator | All clients | Existing administrative proof review |
| Profile with `client` role and `client_users` membership | Own client only | Preserves the direct client-account path |
| Profile with `employee` role and current active SMM seat | Assigned client only | Preserves the proof manager path; resolves the current seat for every read |
| Editor/avatar or other employee with only client/job assignment | None | Assignment is not consent-record authority |
| Retired SMM, ended SMM assignment, or changed profile role | None | No cached grant survives a role or seat change |
| Profileless signed-in caller, anonymous caller | None | No provisioned authority; anonymous has no table grant |
| Service worker / public capture retry | All rows as needed | Existing `service_role` grant and RLS bypass; the public route holds its service client server-side |

The only direct source read outside tests and generated types is
`agent-runtime/src/proof-capture/public-route.ts`: it checks for a prior
submission ID while processing a public capture retry, using the server's
service-role Supabase client. No frontend component reads this table. The
proof-capture admin route lists links and deliveries through its existing
admin/SMM gate, and the delivery worker claims `proof_request_deliveries`.
Migration 294 leaves those routes and the service-only
`accept_proof_capture_submission` RPC unchanged.

The PGlite regression first reproduces the migration-216 assigned-editor
leak, then applies the actual 294 SQL and checks the role/client matrix,
manager transfer and retirement, role changes, anonymous/profileless denial
and service reads. The full disposable schema replay must also pass before
this branch can be considered for release. No live SQL should be applied until
the held stack's recovery and exact-approval release gates are satisfied.
