# Video V3 manual project workspace — 20 November 2026

The Motion Design page now contains a separate code-rendered video section.
An operator can enter an idea, audience, tone, duration and aspect to save an
idempotent manual draft. Existing code-video projects and stage errors are
listed separately from legacy motion renders. A draft's source picker displays
only model sections with a current `supported` review. The operator can choose
up to twelve such sections and add a separately identified note. The start
control calls the exact-version gate from migration 667 only when the
`video_script` agent has been deliberately unpaused.

The default release state keeps that agent paused. Draft creation does not
start a model, render, attach, approve or publish anything. Choosing a source
does not certify the truth of its claims; the start RPC rechecks source and
route currency before queuing. The old Motion Design workflow and its review
history remain present on the same page.

Local checks: five focused code-video and legacy Motion Design UI tests,
TypeScript, lint and frontend build. This UI branch is stacked on the
project-start migration and worker; it has not been deployed to a hosted
environment. Multi-aspect requests, brief and campaign binding in the UI,
storyboard preview/edit, renderer/audio, exact review and finished MP4 output
remain open.
