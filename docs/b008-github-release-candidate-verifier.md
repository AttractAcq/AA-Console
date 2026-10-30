# B008 GitHub release candidate verification

`scripts/verify-github-release-candidate.mjs` creates a read-only premerge
evidence packet. It does not submit a production release candidate to Supabase,
approve an Inbox card, merge a PR, apply SQL, or deploy Railway or Pages.

## Run trusted verifier code against an exact checked-out PR head

```sh
node /path/to/reviewed-verifier/scripts/verify-github-release-candidate.mjs --pr 273 --checkout /path/to/exact-pr-head
```

For a private GitHub repository or a higher API rate limit, supply `GH_TOKEN` or
`GITHUB_TOKEN` through the environment. The tool never prints that token. It
requires the local `HEAD` to equal GitHub's current PR head and the current PR
base to be an ancestor. A changed PR, base, or CI run requires a fresh packet.

The verifier independently reads the GitHub repository and PR API, all check
runs on the exact PR head, and the linked GitHub Actions workflow run. It
requires exactly one successful GitHub Actions check for each of the four
protected CI jobs, all from one successful `CI` pull-request workflow run for
that PR, head, and base. Missing, duplicated, pending, failed, mixed-run, wrong
app, wrong SHA, or incomplete API evidence fails closed. The check names match
`.github/workflows/ci.yml` and the current protected branch configuration. It
also requires byte-identical CI workflow content at the PR base and head,
recording that workflow's SHA-256 in the packet. A workflow change requires a
separate reviewed release of the verifier's trust policy before its new checks
can count. Run the verifier executable from a separately reviewed, trusted
checkout, not from the candidate PR tree; the candidate tree is only the
`--checkout` evidence input. A PR can still change code and test scripts called
by an unchanged workflow, so code review remains a separate release gate.

The migration evidence comes from committed Git objects at that same PR head,
never from caller-supplied hashes or dirty working files. It hashes **every**
pending SQL migration after `supabase/verification/released-migration-version.txt`,
including migrations inherited from a stacked PR base, and requires a
contiguous migration sequence. It rejects a PR that edits or removes SQL at or
before the released source marker, or that changes the marker within the PR.
The marker is source evidence only; it does not prove the live production
migration head.

The typed packet is declared in
`scripts/verify-github-release-candidate.d.mts`. Its deterministic
`packetSha256` hashes canonical JSON excluding the digest field. The packet
has `premergePrHeadSha` and **separate** `futureDeploymentSha: null`; GitHub
does not provide the final squash/merge SHA before merge. It also explicitly
sets `productionSchemaVerified: false` and `releaseAuthorized: false`.

## Controlled rollout sequence

1. Keep this verifier informational while the held migration 288 release source
   remains blocked. Review its packet against the PR's exact head and base.
2. Build a trusted server-side bridge that binds the verified packet to the
   immutable release candidate source in migration 288. Collect independent
   production schema, Railway project/service identity, switch and rollback
   evidence. The migration's candidate shape additionally needs a merge method,
   environment/service IDs and component pins. A browser or Bot claim must
   never stand in for the GitHub API verification.
3. Make the agency-wide Inbox decision AAL2 and source-owned. Before enabling
   any external effect, require an exact-head branch protection check and a
   controlled migration/deployment runner. Each runner must reverify its input
   hashes, the current approval and effect-specific idempotent execution record.
4. After a merge, create a separate deployment identity bound to the **actual**
   main SHA; recheck CI, production schema and live runtime/gateway identities
   before Railway or Pages publication. A premerge PR head is never a
   substitute for the final deployed SHA.

Railway's linked-branch Auto Deploy and Wait for CI settings live outside this
repository. Verify and control them before treating a merge as effect-free.
This code slice changes no production configuration or release switch.
