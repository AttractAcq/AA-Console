# V5 Lambda render transport

The runtime now has a version-matched Remotion Lambda transport. It starts one
private H.264/AAC render for an exact aspect and returns the provider render ID
and bucket. The caller must durably record this handle before polling. Polling,
download and observation are separate from the start call; a transient poll
failure or timeout never starts a second render. A returned handle can be
resumed. A start call that returns no handle is explicitly uncertain and must
be reconciled with the provider before any retry.

The transport has no worker caller, persistent attempt table, deployment URL,
rendered candidate or hosted test yet. This change only establishes the
transport boundary. The rest of Phase 5 still includes durable attempt
recording, critic/contact sheets, final loudness and probe, candidate review,
and attachment.

The API settings were checked against the official [Remotion render API](https://www.remotion.dev/docs/lambda/rendermediaonlambda) and
[render progress and download example](https://www.remotion.dev/docs/lambda/custom-function-names). Runtime and
renderer use `4.0.545`. Five focused preflight/transport tests, typecheck and
the production runtime build passed locally. No AWS render or deployment ran.
