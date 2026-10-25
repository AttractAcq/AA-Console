# SF02 — Connect Meta

**Where.** Clients → [client] → Account → Integrations & Credentials
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF01, MF04, MF14.

## The one rule
A wrong ad account ID here puts real money in someone else's account, and Meta accepts it
silently. Type it carefully.

## Do it
1. **Add** → provider **Meta** → **Account ID** as `act_1234567890`. Meta shows the bare
   number in its own UI; **type the `act_` prefix yourself**. Anything else is refused.
2. **Credential** → the access token. Use a **System User** token from
   Business Settings → Users → System users. A personal token dies with the session that
   made it. The token goes into Supabase Vault and is never shown again, so keep your own
   copy until a build has succeeded.
3. In the table's **Ads** column → **Add page for ads** → **Facebook page ID** (required)
   and **Pixel ID** (optional). Digits only, no prefix, in both.

## Status must read `connected`
`error` means the token is dead. Only the metrics pull writes that state, and only when Meta
rejects the credential. Replacing the credential clears it.

## No pixel means fewer templates
Without a pixel only **P5** and **O2** can build. Everything optimising for conversions or
landing-page views — **R1, R2, R3, C1, C2, C3, O1** — is refused. Get the pixel before
promising a retargeting campaign.

## Troubleshooting
| Symptom | Cause |
|---|---|
| Account ID refused | Missing `act_` prefix, or extra characters |
| Status `error` right after saving | Token invalid or lacks ad account permissions |
| Most templates unselectable | No pixel on the integration |
| Build fails on the page | No Facebook page ID |
