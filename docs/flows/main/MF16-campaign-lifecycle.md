# MF16 — Campaign lifecycle

**Flow.** MF16 · main · Lifecycle
**Purpose.** Clone a campaign into the other mode, reuse what worked, pause, archive and
terminate content — without orphaning external objects or losing lineage.
**Scope.** Campaign Factory, Archive, and the external objects a campaign created.
**Owner.** Marketing Director.
**Last reviewed.** 25 October 2026.
**Entry.** Any campaign that has run.
**Exit.** The campaign is ended, archived, and nothing is still spending or still published
that nobody is watching.

**Composes:** SF18, SF48, SF82, SF22.

---

## The one rule

**A campaign has exactly one mode for its whole life, and a clone copies the thinking but
never the permissions.** A clone takes the brief and the ideation choice. It does **not**
copy creative, performance, external IDs or approvals. If cloning copied approvals, a
person's decision about one exact artifact, destination and budget would silently authorise
a different one.

---

## Cloning: reusing what worked

**Clients → [client] → Delivery → Campaign Factory → Campaigns → [campaign] →
Clone campaign into a new route**

Use it when:

- An organic campaign worked and deserves paid money behind it, or the reverse.
- The same idea should run for a different awareness stage or a different template.
- A campaign needs to change mode. **This is the only way** — mode is immutable.

What comes across, and what does not:

| Copied | Not copied |
|---|---|
| The brief | Creative assets |
| The ideation choice | Approvals of any kind |
| Lineage (`cloned_from_campaign_id`) | External IDs (Meta objects) |
| | Performance and results |

The clone starts empty on the manifest spine and walks MF03 or MF04 from the top. That feels
like duplicated work and is the point: new creative gets a new approval.

**Legacy campaigns.** Campaigns created before v6 sit in an explicit legacy state with no
mode. Do not guess their mode from their channels, template or assets — clone them into an
explicit organic or paid v6 campaign.

---

## Feeding: when one campaign fills another

A campaign can record that it feeds from another (`feeds_from_campaign_id`). This is the P1 →
R1 relationship from MF10: R1 spends against the pool P1 built. Set it so the pair is legible
to whoever reads the account next, and so a decision to pause P1 is understood to starve R1.

---

## Pausing

Pausing is not one action, because a campaign has several things running:

| To stop | Do this |
|---|---|
| Paid spend | In Ads Manager, by a person. The console cannot (**G07**) |
| Organic posts | Hold the slots (SF53), or turn off `publishing_enabled` for everything |
| Proof placements | Leave them. Placed proof is not advertising and should usually stay |
| The sales agent | **Revoke approval**, or disable the deployment (SF67) |
| A published page | Leaving it up is usually right. Taking it down breaks live ad destinations |

**Check what you are starving.** If R1 feeds from P1, pausing P1 quietly degrades R1 over the
following fortnight.

---

## Archiving the campaign

**Clients → [client] → Delivery → Archive → Campaigns** (SF82)

Before archiving:

1. **MF13 is done.** Once it is off the board, nobody reports on it. Read the result and move
   the opportunity's confidence first.
2. **External objects are dealt with.** Archiving in the console does not pause Meta objects.
   An archived campaign whose ads are still live is the worst possible state: spending, and
   invisible on the board.
3. **Pages and magnets it owned are accounted for.** A published page outlives its campaign.
   Decide whether it stays up, and if it does, make sure it is in MF15's drift sweep.

Archive keeps **Content Production**, **Pages**, **Campaigns** and **Sales Agents**, so an
archived campaign is readable, not deleted.

---

## Terminating content

Individual content can be terminated or archived without ending the campaign (SF48):
**Content Production Factory**, or **Archive → Content Production**.

Terminate content when its proof is gone, the claim became untrue, or the client asked. A
terminated piece stops being scheduled and stops being re-proposed by the engine.

If the content is already published, terminating the record does not unpublish the post —
remove it on the platform too, and if it cited proof whose rights were lost, treat it as a
retraction (SF32).

---

## Ending an engagement

When a client leaves, in this order:

1. Turn off all five switches (SF06). This is the single most important step: it stops
   everything external at once.
2. Pause paid in Ads Manager.
3. Disable sales agent deployments (SF67).
4. Decide about published pages with the client — they are on the client's own repository.
5. Revoke capture endpoints (SF61) so nothing keeps creating leads nobody reads.
6. Run MF13 one last time and archive the campaigns.

---

## Troubleshooting

| Symptom | Read this |
|---|---|
| Clone has no creative | Correct. Produce new creative and get a new approval |
| Clone will not change mode | Mode is set at creation. Clone again with the right mode |
| Archived campaign still spending | The console never paused Meta. Do it in Ads Manager (**G07**) |
| Archived campaign's page still live | Pages outlive campaigns by design. Decide deliberately |
| A legacy campaign has no mode | Expected. Clone it into an explicit v6 campaign |
| Engine still proposing archived ideas | Archive the ideas, not just the campaign (SF33) |
