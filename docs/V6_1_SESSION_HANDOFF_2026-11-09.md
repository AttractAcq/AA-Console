# v6.1 session handoff — 2026-11-09

Written so this work can be picked up outside the Claude Code session that produced it.
Per `AGENTS.md`, primary development stays in **Codex or Claude Code**; other assistant
environments coordinate briefs, security review and release gates.

---

## 1. Where the release stands — verified 9 November 2026

| | state |
|---|---|
| **#338** (migration 313, page_deploy executor + composition screen) | **merged** as `a1568f0` |
| **Migration 313** | **APPLIED** by Alex with `supabase db push --linked` |
| **Production** | live identity head `20261106000000`; runtime `a1568f0`, gateway `e3447ab` |
| **Release receipt** | on draft PR #339, **not merged or deployed** |

### Apply and readback evidence

```
cd "/Users/alex/Desktop/Current/Attract Acquisition/aa-console-fresh" \
  && git pull origin main && supabase db push --linked
```

Alex's terminal output showed the CLI selecting and applying only migration 313,
then `Finished supabase db push`. A fresh read-only
`supabase migration list --linked` showed local and remote aligned through
`20261106000000`. The live
`/release/identities` endpoint independently reported complete observations,
the same migration head, runtime SHA `a1568f0ad8f2a8e53a994291e2817f72c76831b7`
and gateway SHA `e3447aba23b2af6081c526fe5b8fd12225decdc9` at
2026-11-09 18:35 UTC.

`supabase db push --linked` from the repo remains the **only sanctioned apply path**.
Never run `supabase migration repair --status reverted`.

The apply was not done from a cloud session: the Supabase MCP tools require the
migration SQL to be retyped into a tool argument (`apply_migration` also stamps its
own timestamp version, which would record 313 as `20261109…` and break the sequence
gate). `db push` reads the file from disk and writes the ledger's `statements` array
faithfully.

### Remaining release work

PR #339 already contains the prepared receipt. It changes:

- `supabase/verification/released-migration-version.txt` → `20261106000000`
- `scripts/production-recovery-preflight.mjs` → count `330`, marker `20261106000000`
- `scripts/production-recovery-preflight.check.mjs` → same two values
- `supabase/verification/browser-release-components.json` → `migrationHead`
  `20261106000000`, `runtimeSha` `a1568f0…` (**repinned**, `agent-runtime/` changed)

`gatewaySha` stays `e3447ab…` — `aa-mcp-gateway/` is clean.

Verified locally before the apply: migration-order `pendingCount 0`;
require-released-schema matching; preflight self-tests 17/17; release-identity
self-tests 4/4; both component pins clean against `a1568f0`. Review current-head
CI and release identities before taking the PR through Alex's release gate.

**Pin check is `git diff --quiet <pin> HEAD -- agent-runtime/`** — ANY change in that
directory stales the pin, including a test file or a regenerated manifest. "No source
changed" is not the test; the directory is.

---

## 2. What migration 313 does

`page_deploy` was the only one of 34 approval classes whose executor was reachable
without a connected provider account. 237 already gated the write on the exact approved
bytes. The gap was one step later: the runtime publishes `htmlToPublish(page.html)`,
which **injects the sales-agent widget**, so committed bytes ≠ approved bytes — and
`record_campaign_page_published_v6` took the caller's hash on trust while holding the
snapshot that would disprove it.

313 adds `campaign_page_publications.published_sha256`, verifies `rendered_sha256`
against the snapshot, and requires the hash of the bytes actually committed.

**Trap worth remembering:** adding a defaulted parameter creates an **overload**, not a
replacement. 313 drops the 4-arg signature explicitly; a test asserts one function of
that name remains. Third `create or replace` trap on this branch, after 310
(cannot remove parameter defaults) and 311 (cannot safely change a reproduced body's
signature).

---

## 3. OPEN DEFECT — the composition screen shipped in #338 is miscalibrated

This is the most important open item and it is a defect in work already merged.

`agent-runtime/src/agents/creative_build/screen.ts` measures the fraction of a frame
that is flat **and light** (`sd < 6` and `mean > 170`). It records; it refuses nothing.

I measured **all 342 render frames in production** (not the 13 originally eyeballed)
and then opened the images. Findings:

### 3.1 The thresholds were calibrated against a false control

The "image-led control group" (Attract Acquisition V2, scoring 0.0–0.3%) is **not
image-led**. Those frames are text cards on **dark** backgrounds — a blue/black block
over ~70% of the frame with photography behind it. They score 0.0% only because
`mean > 170` fails. The pinned separation in `screen.test.ts` was separating **light
cards from dark cards**, not cards from pictures.

| frame (verified by eye) | flat-light | flat-dark | shipped verdict |
|---|---|---|---|
| engine-bay photo, genuine (AA) | 0.5% | 19.2% | `image_led` ✓ |
| V2 "R7,500" blue/black card | 0.0% | **57.4%** | `image_led` ✗ |
| V2 "PROOF/VOLUME" dark type | 0.0% | **61.6%** | `image_led` ✗ |
| Harbour Dental text poster | 62.5% | 0.0% | `card_led` ✓ |
| AA empty story frame | 100.0% | 0.0% | `card_led` (blank) |

**87 frames** the shipped screen calls `image_led` are heavily flat once colour is
ignored; 46 of them are V2's.

### 3.2 The obvious fix does not work

Measuring flat regardless of brightness calls **100% of every client's frames** cards,
including the genuine engine photograph at 19.7%. Photographs legitimately contain large
flat **dark** regions (shadow) but rarely large flat **light** ones. Light and dark need
**different thresholds**, and there are not yet enough labelled dark examples to set one
honestly. A threshold somewhere in flat-dark 20–70% is indicated but **not yet earned**.

Next step: label frames across the flat-dark band (72 candidates sit in 15–70% with a
`image_led` shipped verdict) and derive the threshold from them, as the original
light-side threshold was derived.

### 3.3 Blank renders are shipping

11 story frames score ≥85% flat-light. The 100% one was opened and is **completely blank
white**. These are render failures leaving the system as deliverables and nothing catches
them. A blank-frame check is unambiguous and cheap and does not need a product decision.

### 3.4 Ordering constraint

Any change under `agent-runtime/` stales `runtimeSha` in the receipt on draft PR #339.
**The screen fix must land as a separate PR after 313's release**, not before.

---

## 4. The product question, as it actually stands

Originally framed as "is the card-led house style right for client e4b4b001". The
measurement changes it:

- `e4b4b001` **Attract Acquisition** and `0d0f9c33` **Attract Acquisition V2** are both
  AA's own accounts.
- **Harbour Dental** (`d4c87828`) is the only external client with imagery, and is
  **5 of 6 card-led**, median 40.7%. The worst is a pure typography poster with no
  imagery whose copy reads *"Say that to any dentist who puts photographs in front of
  you. Including us."* This is the original defect, live, on a paying client.
- A meaningful share of AA's own briefs **commission cards explicitly** ("identity card",
  "typographic disqualifier card", "static mechanism card", "signed policy card"). The
  screen flagging those is correct behaviour on content that genuinely is a document.

So the decision is **not** "is the card style right" in general. It is narrower:
Harbour Dental's briefs, and AA's own paid Meta statics (as distinct from the D1–D14
nurture card series).

Two earlier text-proxy measurements were both wrong and are superseded: "declares no
imagery" (18%→0%) and "paper in frame" (13%→48%). Both read the concept text, not the
render. `docs/AA_CONSOLE_V6_1_BUILD_PLAN.md` item 9 was corrected accordingly.

---

## 5. Other carried items

- `production-release-approval.yml` has no `if:` guard, so it runs and fails on every PR.
  Cosmetic red check; it failed identically on #337 and #338, both of which merged fine.
- Leaked-password protection is disabled in Supabase Auth.
- **#254 and #298 are cherry-pick-only — never merge them.**
- #257 / #267 relate to Q012 / Q014.
- Per-piece type owed from the planner.
- `client_media_assets` has no inbox route (`ordinary_media` needs a byte snapshot).
- The `v5/` directory label.
- Engine tab de-duplication — the one Phase 4 piece needing no executor, blocked on
  where cadence settings go.

### Phase 4 executors — out of scope for v6.1 (Alex's decision)

Of 34 approval classes, `page_deploy` is now the only one with a verified executor.
`sales_entitlement` is a **product activation, not a code gap**: `inbox_enforced`
short-circuits `is_eligible_lead_owner` to false, and switching it on *grants* sales-seat
access. The rest need connected provider accounts (Google reply sender, live SMTP, Meta).

---

## 6. Release boundary

Per `AGENTS.md`: prepare code, tests and a reviewable PR; **do not merge, apply
production migrations or deploy to Railway without Alex via Chief of Staff.**
