# Code-video production prerequisites — 21 November 2026

This is a read-only production inventory, not a finished-video acceptance or a request to turn on a worker.

The published Console browser was `e6d5d1e`, runtime `7be083f`, gateway `a71aa64`, and production database migration head 701 at the release check. The global Engine and all client outward switches were off. The in-house client's older daily-package setting was on, but no v6 daily-video source was configured.

All three `agents` rows for `video_script`, `video_audio`, and `video_render` were paused. The production Railway service had a script-model API key name present. No ElevenLabs key name or `REMOTION_AWS_*` variable name was present. No credential value was read. Remotion licence eligibility or a Company Automators licence is not attested in [the licence note](../video-render/LICENSE-NOTE.md). A local silent MP4 fixture and a source-level CI pass do not establish a narrated provider render.

Before the first paid provider run, the owner needs to record the Remotion licence basis, select the AWS/Remotion and ElevenLabs accounts, configure the protected credentials, deploy and read back the renderer, and verify the exact narrator/voice and cost controls. Then release the script, audio and render agents in a scoped test, using a reviewed brief and source packet. Keep distribution separately gated. Capture actual provider receipts, Storage bytes, audio alignment, critic result, approved MP4 hash and human decision for both a manual and campaign request.

The Console now displays which video workers are paused before an operator starts a draft and labels a timed project when its render worker is paused. Saving a draft remains available. The read-only signed-in check is in `/Users/alex/Desktop/AA-v7-post-release-desktop-check-prompt-2026-11-21.md`; it has not been performed from this CLI because the Chrome access host was unavailable.
