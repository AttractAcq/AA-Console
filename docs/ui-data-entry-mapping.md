# UI → Data Entry Mapping

This document maps every input **button** in the AA Console UI to the **dependencies** —
the data fields/cards currently rendered as placeholders on that same page. Each button
opens a form-shaped `Modal` that is empty today (this is a wireframe/mockup app with no
backend yet). The dependencies are what that form needs to collect, because they are the
exact fields the page renders back out once real data exists.

**How to use this doc:** when building the Supabase schema and the input forms, each
"Button" row below becomes one form (usually one INSERT/UPSERT), and each item in its
"Dependencies" list becomes a field on that form / a column (or related row) that the
page reads back to render the UI. Rows marked **Scope: per-client** live under
`/clients/:clientId/...` and need a `client_id` foreign key + RLS scoped to that client.
Rows marked **Scope: agency-wide** are shared across the agency (no `client_id`).

Pages with **no button** are read-only today — listed for completeness, since they'll
still need a data source (a table, or a view aggregating other tables), just not a
dedicated input form yet.

---

## Dashboard

**Route:** `/` · **Scope:** agency-wide

No input button — read-only aggregate view.

**Data shown:** MRR, Active Clients, Open Jobs, Active Agents (stat cards); a live list of
`Client` cards (see Clients below); Quick Links (static nav, not data).

---

## Clients

**Route:** `/clients` · **Scope:** agency-wide

**Button:** `Add Client`

**Dependencies (Client record):**
- Name
- Initials
- Sector
- Location
- Tier
- Is Internal (flag)

---

## Operations

**Route:** `/operations` (tabs: Avatars, Editors, SMM, Calendar) · **Scope:** agency-wide

### Avatars tab
**Button:** `Add Avatar`
**Dependencies (Team Member record, category = Avatars):**
- Name
- Initials
- Engagement Type (Employee / Contractor)

### Editors tab
**Button:** `Add Editor`
**Dependencies (Team Member record, category = Editors):** same fields as Avatars.

### SMM tab
**Button:** `Add SMM`
**Dependencies (Team Member record, category = SMM):** same fields as Avatars.

### Calendar tab
**Button:** `Add Event`
**Dependencies (Scheduled Event record):**
- Date / Day
- Ref Number (links to a media/content asset)

---

## Team member detail pages

**Route:** `/operations/:category/:memberId/:section` · **Scope:** agency-wide, scoped to one team member

### Overview section
**Button:** `Add Information`
**Dependencies:**
- Total Compensation
- Total Output
- Personal Information
- Contact Information

### Current Jobs section (Avatars / Editors)
**Button:** `Assign Job`
**Dependencies:**
- Job Count
- Due Date
- Table — Current Jobs, Due Date, Compensation (one row per assigned job)

### Current Clients section (SMM)
**Button:** `Assign Client`
**Dependencies:**
- Client Count
- Due Date
- Table — Current Clients, Due Date, Compensation (one row per assigned client)

### Finished Work section (Avatars / Editors)
No button — file library, filterable by Image / Text / Video.
**Dependencies:** Submission files (one `FileAssetCard` per file: file, media type, uploaded date).

### Logged Work section (SMM)
No button.
**Dependencies:** Table — Work Done, Date, Time Taken (one row per logged work entry).

### Contract section
**Button:** `Add Payment`
**Dependencies:**
- Pay Due
- Due Date
- Table — Service Rendered, Compensation, Payment Date (one row per payment)

---

## Team

**Route:** `/team` (tabs: Chat, Agents) · **Scope:** agency-wide

### Chat tab
**Button:** `Add Channel`
**Dependencies (Channel record):**
- Channel name
- Messages (per-channel message list)

### Agents tab
**Button:** `Add Agent`
**Dependencies (Agent record):**
- Name
- Initials
- Status (Active / Idle)

---

## Agent detail pages

**Route:** `/team/agents/:agentId/:section` · **Scope:** agency-wide, scoped to one agent

### Overview section
No button.
**Dependencies:** Total Cost, Average Monthly Cost, Runs, Failed Runs, Failure Rate.

### Actions section
No "Add" button — 3 action triggers, each opens a modal:
- `Run Agent`
- `Pause Agent`
- `Edit Configuration`

**Dependencies:** agent configuration parameters (whatever `Edit Configuration` collects) and
a run-history record created by `Run Agent` / `Pause Agent` (state + timestamp).

### Logs section
No button.
**Dependencies:** Table — Description, Date, Time (one row per log entry).

---

## Admin

**Route:** `/admin` (tabs: Financials, SOPs) · **Scope:** agency-wide

### Financials tab
**Button:** `Add Input`
**Dependencies:**
- MRR, CAC, LTV (stat cards)
- Statement sub-view (Income Statement / Balance Sheet / Cash Flow Statement — one
  statement body per selected type)

### SOPs tab
**Button:** `Add SOP`
**Dependencies:** Table — SOP, Owner, Last Updated (one row per SOP).

---

## Clients / Delivery / Intelligence

**Route:** `/clients/:clientId/delivery/intelligence` (tabs below) · **Scope:** per-client

### Business Context tab
**Button:** `Business Input`
**Dependencies:**
- Business Overview
- Current Revenue
- Target Revenue
- Current Marketing
- Ideal Customer
- Main Offer
- Competitors
- Proof / Testimonials

### ICP tab
**Button:** `ICP Inputs`
**Dependencies** (one record per ICP item, each with a `type` of `core` or `question` and a
description shown as help text):
- Avatar role map
- Visual identity
- Social circle
- Status markers
- Daily environment
- Trusted advisors
- Objections
- Purchase trigger
- Language patterns
- Desired outcomes
- Risk and fears
- Attention channels
- Decision criteria
- Question universe
- Buyer role system

### Competitors tab
**Button:** `Competitor Inputs`
**Dependencies:**
- Positioning and category map
- Offer and commercial objectives
- Messaging and claims
- Proof and trust observations
- Distribution and attention observations
- Competitive landscape patterns

### Branding & Associations tab
**Button:** `Branding Inputs`
**Dependencies:**
- Positive and negative association map
- Trust and credibility signals
- Proof and authority ecosystem
- Emotional, symbolic and language cues
- Buyer-role and segment variation
- Tensions, cautions and unknowns

### Campaign Intelligence tab
**Button:** `Campaign Inputs`
**Dependencies:** Quarter 1, Quarter 2, Quarter 3, Quarter 4 (one note/record per quarter).

---

## Clients / Delivery / Strategy

**Route:** `/clients/:clientId/delivery/strategy` (tabs below) · **Scope:** per-client

### Branding Strategy tab
**Button:** `Branding Input`
**Dependencies:** Cross-OS Synthesis, Strategic Recommendations, Recommended Portfolio.

### Offer Strategy tab
**Button:** `Offer Input`
**Dependencies:**
- Value Equation: Dream Outcome, Likelihood of Achievement, Time Delay, Effort and Sacrifice
- Guarantee
- Bonuses: Bonus 1, Bonus 2, Bonus 3, Bonus 4
- Scarcity
- Urgency

### Money Model Strategy tab
**Button:** `Money Model Input`
**Dependencies:**
- Model
- Offers: Attraction Offer, Continuity Offer, Upsell Offer, Downsell Offer

---

## Clients / Delivery / Proof Bank

**Route:** `/clients/:clientId/delivery/proof-bank` · **Scope:** per-client

No button. Filterable by media type (Image / Text / Video).

**Dependencies:** Proof assets — one record per proof asset (file/text, media type, upload date).

---

## Clients / Delivery / Ideation

**Route:** `/clients/:clientId/delivery/ideation` (tabs below) · **Scope:** per-client

### Generation tab
No "Add" button — 3 action triggers, each opens a modal:
- `Manual Idea`
- `Auto Idea`
- `Proof Idea`

**Dependencies:** Table — Idea, Type, Status (one row per generated idea), filterable by media type.

### Briefs tab
No button. Filterable by media type.
**Dependencies:** Table — Brief, Type, Status (one row per brief).

---

## Clients / Delivery / Media

**Route:** `/clients/:clientId/delivery/media` (tabs below) · **Scope:** per-client

### Image Library tab
No button. Sortable (Newest first / Oldest first).
**Dependencies:** Image assets — one record per image (file, uploaded date).

### Video Library tab
No button. Sortable (Newest first / Oldest first).
**Dependencies:** Video assets — one record per video (file, uploaded date).

---

## Clients / Delivery / Approvals

**Route:** `/clients/:clientId/delivery/approvals` · **Scope:** per-client

No button. Filterable by media type.

**Dependencies:** Table — Asset, Type, Status (one row per asset awaiting approval).

---

## Clients / Delivery / Distribution

**Route:** `/clients/:clientId/delivery/distribution` (tabs below) · **Scope:** per-client

### Organic tab
No button. Month calendar + filterable by media type.
**Dependencies:** Scheduled organic posts — Date/Day, Ref Number, media type.

### Paid tab
No button. Month calendar + filterable by media type.
**Dependencies:** Scheduled paid assets — Date/Day, Ref Number, media type.

---

## Clients / Delivery / Conversion

**Route:** `/clients/:clientId/delivery/conversion` (tabs below) · **Scope:** per-client

### Primary Landing Pages tab
**Button:** `Build Page`
**Dependencies:** Page Preview (one record per landing page: thumbnail/URL, page content).

### Secondary Offer Pages tab
**Button:** `Build Page`
**Dependencies:** same as Primary Landing Pages, for offer pages.

---

## Clients / Delivery / Prospects & Leads

**Route:** `/clients/:clientId/delivery/prospects-leads` · **Scope:** per-client

**Button:** `Add Lead`

Three pipeline-stage columns, each with a count.

**Dependencies (Lead/Prospect record):**
- Pipeline stage (First Touch / Second Touch / Call Booked)

---

## Clients / Delivery / Reporting

**Route:** `/clients/:clientId/delivery/reporting` (tabs: Organic, Paid, Landing Pages, Offer Pages)
**Scope:** per-client

⚠️ Not wired to a dedicated component yet — every tab falls back to a generic empty
state showing just the tab label. No button exists here today.

**Dependencies:** none defined yet — this will eventually need aggregated analytics
pulled from the Distribution and Conversion tables above (reach, spend, conversions,
page views, etc.) rather than its own input form.

---

## Clients / Account / Onboarding

**Route:** `/clients/:clientId/account/onboarding` · **Scope:** per-client

**Button:** `Start`

**Dependencies (checklist step records):**
- Onboarding Form
- Onboarding Call
- Credentials Collected

---

## Clients / Account / Integrations & Credentials

**Route:** `/clients/:clientId/account/integrations` · **Scope:** per-client

**Button:** `Add`

**Dependencies:** Table — Integration, Credential, Access Level (one row per connected integration).

---

## Clients / Account / Contracts & Legal

**Route:** `/clients/:clientId/account/contracts` · **Scope:** per-client

**Button:** `Add Contract`

**Dependencies:** Contract files — one `FileAssetCard` per contract (file, uploaded date).

---

## Clients / Account / Billing & Subscription

**Route:** `/clients/:clientId/account/billing` · **Scope:** per-client

**Button:** `Add Information`

**Dependencies:**
- Current Plan
- Upsell Opportunity
- Client Duration

---

## Clients / Account / Audit Log

**Route:** `/clients/:clientId/account/audit-log` · **Scope:** per-client

**Button:** `Add Audit`

**Dependencies:** Table — Member, Date, Audit Notes (one row per audit entry).

---

## Out of scope: auth pages

The Admin (`/login`), Client (`/client/login`) and Employee (`/employee/login`) sign-in
pages, and the role-switch modal, aren't data-entry forms for the tables above — they
back a `users`/session table plus role, and are already isolated per
[the three-console auth design](../src/context) (`auth.tsx`, `clientAuth.tsx`,
`employeeAuth.tsx`). Not mapped here.
