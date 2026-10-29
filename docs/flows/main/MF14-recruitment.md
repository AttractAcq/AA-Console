# MF14 — Recruitment

**Flow.** MF14 · main · Internal
**Purpose.** Run AA's own hiring as campaigns — attract applicants for avatars, editors and
SMMs — using the same machinery as client delivery without contaminating client data.
**Scope.** Team → Recruitment, Recruitment Landing Pages, Recruitment Distribution.
**Owner.** Whoever owns hiring.
**Last reviewed.** 25 October 2026.
**Entry.** E6 — AA needs to hire.
**Exit.** Applicants arriving against a recruitment page.

**Composes:** SF02, SF57, SF68.

---

## The one rule

**Recruitment is deliberately separated from client delivery, and the separation is in the
data, not in a convention.** Content carries `content_purpose = 'recruitment'` rather than
`'client'`; pages carry `page_type = 'recruitment'`; recruitment campaigns and their ads live
in their own tables. A recruitment page filed as a client `landing` page would appear in a
client's Page Builder, and the first person to publish one to a client's site would have no
warning. Keep the purpose right and that cannot happen.

---

## Where it lives

**Team → Recruitment** · **Team → Recruitment Landing Pages** · **Team → Recruitment
Distribution**

These are agency-level pages, not client pages. The content archive and every client-facing
list exclude recruitment on purpose.

---

## Stage 1 — Decide the role

Roles are `recruitment_role` — the categories AA actually hires: **avatars**, **editors**
and **SMM** (`team_category`). Name the hire by what they will do; the ads and the page are
written from it.

---

## Stage 2 — The landing page

**Team → Recruitment Landing Pages**

Build the page an applicant lands on. It is a real page with a real `page_type` of
`recruitment` (SF57 covers building and revising pages generally).

What it needs: what the role is, **How it works**, what AA is, and a form. The form needs a
capture endpoint the same way a client page does (MF11 stage 2) — an application that posts
nowhere is the same failure as a lead that posts nowhere.

---

## Stage 3 — The campaign

**Team → Recruitment Distribution**

| Field | Notes |
|---|---|
| **Campaign name** | What it is called in Meta |
| **Daily budget** | Hiring budgets are small; set it deliberately |
| **Countries** | Where you will actually hire from |
| Call to action | **APPLY_NOW** for hiring. `LEARN_MORE` and `CONTACT_US` exist for other uses |
| Creative | **Editor image** and the role-specific creative, e.g. **Editor hiring**, **Join AA** |

The recruitment Meta builder is its own agent, separate from the client Meta builder, writing
to its own campaign and ad records.

---

## Stage 4 — Build and launch

As with client paid campaigns, objects are created **paused**. Nothing here makes an ad live.
A person launches in Ads Manager.

States shown: **Building** → built, or **Build failed** with the reason.

---

## Stage 5 — Applicants

Applications arrive through the page's capture endpoint. Work them like any pipeline (SF68),
but keep them out of client lead reporting — they are not client leads and must never be
counted as such.

When someone is hired, they become a team member under
**Team → Avatars / Editors / SMM**, as `employee` or `contractor` (`engagement_type`), and
from then on they receive brief dispatches in MF08.

---

## Troubleshooting

| Symptom | Read this |
|---|---|
| Recruitment content in a client list | `content_purpose` is wrong on the record |
| Recruitment page in a client Page Builder | `page_type` is `landing` instead of `recruitment` |
| **Build failed** | The reason prints. Usually the Meta integration, as in SF02 |
| Applications not arriving | The page's capture endpoint — same checks as MF11 stage 5 |

---

## Note

This flow uses AA's own house client. Everything in MF04 about pixels, tokens and paused
objects applies here too, because it is the same Meta plumbing.
