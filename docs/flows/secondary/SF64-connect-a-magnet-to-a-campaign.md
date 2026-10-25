# SF64 — Connect a magnet to a campaign and its gating page

**Where.** Lead Magnet Studio, and Sales OS (v2) → Capture
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF11.

## The three bindings a magnet needs
A magnet on its own does nothing. It needs:

| Binding | Where | Why |
|---|---|---|
| **A campaign** | Lead Magnet Studio → **Attribute to campaign** | So opt-ins are attributable (MF13) |
| **The page that gates it** | The page's capture endpoint (SF61) | So the magnet is the reward for a real opt-in |
| **The capture endpoint's magnet version** | SF61 | So the right version is delivered |

## Do it
1. **Attribute to campaign** on the magnet.
2. Create or edit the capture endpoint for the gating page (SF61), and bind the approved
   **magnet version** to it.
3. Check the consent wording covers delivering a file by email.

## Reading the result
**Lead Magnet Studio → Opt-ins** shows who opted in, whether they **Became a lead**, and what
they were **Attributed to**. That table is how you know the whole chain works.

## Gotcha
Bind the **version**, not the magnet. Binding loosely to "the magnet" would mean a new,
unapproved version could start being sent by a change elsewhere.

## Then
Run the page probe (SF60) — it proves the opt-in path end to end.
