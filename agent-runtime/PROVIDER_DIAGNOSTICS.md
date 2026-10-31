# Provider diagnostics: controlled read-only slice

`src/agents/token_health/provider-diagnostics.ts` is an opt-in diagnostic
contract. The scheduled `token_health` worker does **not** invoke it. No
production provider request, Vault read, refresh, integration status update,
or external action was added by this slice. A future caller must supply a
fetch implementation, a credential, the exact account handle, and the
operation's required scope policy. Results contain no credential or provider
response body.

| Provider | Read-only evidence available from this module | What remains unknown |
|---|---|---|
| Meta paid account | `debug_token` validity and expiry; expected app ID and declared scope list when supplied; exact `act_<id>` GET readback | Page/pixel target grants, write/ads permissions, and any approved action |
| Instagram | Same token/app/scope check; exact numeric IG account GET readback | Publishing and media rights for an exact approved package |
| Google Business Profile | Exact `accounts/<account>/locations/<location>` GET readback against the v4 resource used by the current writer | Refresh and posting rights; a successful read is not a local post acceptance receipt |
| Google Ads | Explicit `unknown`; no provider call | OAuth, developer token, manager/customer access, conversion action and build rights |
| Resend | Explicit `unknown`; no provider call | The current runtime-wide key, verified domain and send permission; a sending-only key may not have read/list permission |
| Other/generic provider | Explicit `unknown`; no provider call | All account, scope and action rights |

Each check is `verified`, `blocked`, or `unknown`. `verified` is limited to the
specific read named in its reason. The `action` check remains `unknown` for
every provider. Transport faults, rate limits, malformed responses and
missing policies remain `unknown`; explicit invalidity, missing scopes,
app mismatch and exact account mismatch are `blocked`. The module accepts
only GET requests to fixed Meta or Google hosts and refuses redirects.

The opt-in `probeProvider` request now requires a `capabilityKey` with the
exact client ID, integration row ID, nonsecret credential version, provider,
account/location reference, and action key, plus the current local credential
state (`eligible`, `revoked`, or `unknown`). A revoked or unknown generation is
not probed. Its `capability` result is made by
the pure `evaluateProviderCapability` contract in `provider-capability.ts`.
It uses a 60-second direct-read evidence window, capped by known token expiry.
Only `meta.account.read`, `instagram.account.read`, and
`google_business.location.read` can become `verified`, and only after the
provider's exact account/location read succeeds with the required supporting
checks. Configured/connected metadata, another client or row, a rotated
credential, another destination or action, expired/stale evidence, revocation,
and unsupported providers cannot produce a positive result. Publish, send,
build, spend and all other external actions remain `unknown` or `blocked`.
The result contains only fixed reason codes, timestamps and nonsecret key
fields; it never contains a credential or provider response body.

The key is caller-supplied local identity, not an assertion from Meta or
Google that the credential belongs to that AA client and row. A future
production caller must obtain the key and local state from an authorized,
exact-row credential lookup and persist evidence against the same credential version. This slice
does not read a production credential, write a capability record, grant an
external action, or change any UI status. Q019's schema and controlled real
provider pilots remain prerequisites for an operational B013 rights gate.

Before operational use, B015 still needs a reviewed account/scope policy for
each action, per-client OAuth and refresh custody, a way to persist dated
capability evidence without exposing tokens, due-view preflight, and an
authorized controlled pilot with real provider readbacks. The existing
Account and System Readiness pages now show provider-specific gaps from
metadata without calling a provider or claiming those gaps are closed.

Source for the Business Profile v4 location read and its OAuth scopes:
[Google `accounts.locations.get`](https://developers.google.com/my-business/reference/rest/v4/accounts.locations/get).
The current writer uses the same v4 location resource for local posts.
[Resend key permissions](https://resend.com/changelog/new-api-key-permissions)
explain why a sending-only key cannot be certified by a read/list request.
