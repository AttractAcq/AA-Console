# SF05 — Read integration health and replace a dead credential

**Where.** Clients → [client] → Account → Integrations & Credentials, and `integration_health`
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF01, MF09, MF13.

## Why it matters
A dead token is silent. Posts stop publishing, metrics stop arriving, and both look like
"the client had a quiet week" until someone checks.

## Do it
1. Read the status column. `connected` is healthy; `error` means the provider rejected the
   credential.
2. **Only the metrics pull writes `error`**, and only when the provider rejects it. So a
   credential can be dead for a while before the state catches up — if metrics have gone
   quiet, suspect the token before you suspect the audience.
3. Replace the credential. Saving a new one clears the error state.
4. Re-check after the next metrics pull (`metrics_pulls`).

## Token health
A `token_health` agent runs on a schedule and reports what it finds. Read it rather than
waiting for a client to notice.

## Troubleshooting
| Symptom | Cause |
|---|---|
| Organic metrics stopped | Platform token expired |
| Paid metrics stopped but ads running | Ad account token or permission change |
| Status flips back to `error` | The replacement token lacks a permission the old one had |
