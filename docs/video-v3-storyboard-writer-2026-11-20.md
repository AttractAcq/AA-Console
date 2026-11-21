# Video V3 storyboard writer — 20 November 2026

`agent-runtime/src/video/storyboard.ts` is the first source-bound writing
stage. It accepts a typed idea, audience, tone, requested aspects, target
length, component catalogue and up to twelve dated source notes. It asks the
configured Anthropic model for one IR plus a source-ID list for every scene.
The source packet is capped, identified and hashed. A missing or unknown
source ID, duplicate scene coverage, request mismatch, invalid JSON or failed
IR preflight holds the output. One correction attempt is allowed; both calls'
tokens and estimated cost are retained even when validation fails.

When no source notes exist, a draft may cite only `operator_prompt` and is
marked `unsourced`. This enables a creative manual prompt without inventing
business evidence. Citation IDs establish lineage, not factual truth. An
independent source/claim review and renderer Zod/timeline compile are still
required before advancing a project.

This module does not yet claim a queue job, write `video_projects`, call a
provider during tests, render, attach an asset or open an approval request.
Local verification: runtime typecheck/build and 15 focused contract,
validation and writer tests using a mocked completion. No hosted state or
outward switch changed.
