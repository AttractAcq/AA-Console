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
