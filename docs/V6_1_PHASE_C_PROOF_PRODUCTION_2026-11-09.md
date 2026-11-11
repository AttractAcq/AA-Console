# Phase C: Proof Production capture and approval handoff

## Product decision

The six capture methods run on their own cadence. A campaign may select already approved proof; it does not start a capture run or treat an unreviewed submission as available. Each method is independently enabled and can stop without stopping the others. Capture creates a **raw source** first, then production may make a distribution asset or a claim-bearing proof artifact. These are distinct review decisions.

| Capture method | Independent trigger and cadence | Raw handoff | Ready-to-distribute artifact and human gate |
| --- | --- | --- | --- |
| Automated Requests | Configured business event or scheduled request cycle, subject to recipient and channel settings | Delivery plus a submitted review, quote or media file, with source and consent text | Cleared `client_proof_assets` source; a produced `client_media_assets` item must pass asset review, or a `proof_artifact_versions` claim must receive signoff. Sending the artifact to a destination needs its own placement approval. |
| Field Capture Portal | Field team submits after a job, visit or milestone; the portal remains available independently of campaigns | Job photos, video, voice or written evidence with submitter, job reference and permission text | Same source clearance and asset/artifact review. The reviewer checks that job evidence supports the claimed result and that customer or employee permission covers the proposed use. |
| Guided Interview Capture | Interview schedule set by the account team, with a prepared script and private capture link | Answers, recordings and supporting evidence, tied to participant and consent | Reviewed excerpt, quote or produced media asset with exact source retained. A human checks transcription, factual claim and usage rights before approval. |
| Integration Capture | Source-specific polling or webhook cadence after a connector is enabled | Attributed external review, certificate or other record plus source URL, timestamp and any media | Normalized proof source with verifiable origin and rights; claim or asset approval follows the same human gate. **The current Capture screen is a placeholder; no connector or autonomous cadence should be represented as live.** |
| Manual Upload & Import | Operator initiates import as historic material becomes available | Uploaded file or written source, source format, category and provenance | Cleared source followed by reviewed asset or signed claim artifact. Historic material needs a current permission basis and expiry check before reuse. |
| Outcome Follow-up Engine | Scheduled follow-up after the recorded outcome window, independent of campaign launch | Customer outcome response and evidence, linked to the original work and time elapsed | Supported before/after or measured-result artifact, with units and source evidence checked by a person. **The current Capture screen is a placeholder; follow-up scheduling and autonomous collection are not live.** |

## State boundary

1. A capture setup or request is not proof. The private capture link accepts a submission into Raw.
2. A person reviews the raw source, records `usage_rights`, `permission_basis` and expiry where relevant, and corrects or rejects unsupported claims.
3. Proof Production may turn a cleared source into media or a claim-bearing artifact. `client_media_assets.review_status = approved` is the media handoff; `proof_artifact_signoffs` is the claim handoff. Neither substitutes for the other.
4. Campaigns and other consumers may reference only approved, unexpired proof with compatible rights. They never enqueue capture as an implicit dependency.
5. Distribution is a further decision. `create_proof_placement_v6` drafts a destination placement, whose own approval gate controls release. The current executor coverage limits still apply.

## Build status

Automated requests, field capture, guided interviews and manual import have setup or capture UI today. The integration and outcome follow-up cards are placeholders. The current screens do not implement a six-method scheduler. This decision specifies the intended cadence and handoff; it does not claim those unfinished capture methods are operational.
