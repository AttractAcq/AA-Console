# SF04 — Connect the site repository

**Where.** Clients → [client] → Account → Sites → Overview / Settings
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF01, MF11.

## Why it matters
Pages are published as commits to the client's own repository. Without this there is nowhere
for MF11 to publish, and every page stays a preview.

## Do it
1. **Sites → Overview** — if it reads *"No website for this client yet"*, use
   **Create Website Repo**.
2. **Sites → Settings** — the GitHub installation: **App ID**, **Installation ID**,
   **Organisation**, **Status**.
3. Confirm **Status** is healthy before relying on it.

## Gotcha
This is account-level configuration, not a delivery step — which is why it lives in Account
and not in Website Studio. Website Studio builds and publishes; Account decides where to.

## Troubleshooting
| Symptom | Cause |
|---|---|
| Publish fails with no destination | No repository connected |
| Publish fails on permissions | The GitHub App is not installed on that org or repo |
| Repo exists but publish refused | Read `campaign_page_publish_due` (SF59) |
