# V7 video distribution status

This source change extends the code-video project status with four local distribution observations for its exact attached asset: posts scheduled or publishing, published rows with an external ID or URL, the latest such timestamp, and published rows lacking an external reference. The operator view and read-only Chief of Staff/Production bot tool show the same distinction.

An attached render, a human approval, a scheduled slot and a recorded external post are separate states. An external reference in the Console is a local record, not independent provider read-back. The new view does not initiate scheduling, publishing or a provider call. Cross-client access remains governed by the security-invoker view and the bot RPC's client grant.

## Verification

- The video draft fixture checks that a project with no attachment has zero distribution counts, and that bot reads do not overstate them.
- Focused operator and gateway tests cover display and exact-response validation. Clean/upgrade schema replay, generated types and the remaining video fixtures are required before this source is proposed for merge.

No hosted migration, provider publish, external read-back, video activation or outward switch change is included. The full video journey and original Phases 8 and 9 remain unaccepted.
