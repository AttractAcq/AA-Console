# V7 video project status for bots

This source change gives the Chief of Staff and Production bots one read-only status call for a code-video project. `content.video_project_status` requires the exact client and project IDs. The gateway checks the bot and client grant, and the runtime calls a service-only RPC that rechecks both before reading the project. The result contains recorded stage, progress counts, estimated cost, current attachment and human asset review state. It contains no source snapshot or private media URL.

The result describes database records. A render candidate, attached asset or bot approval is not a human-approved video or a published post. No bot can start, approve, distribute or change a video through this tool. The existing video workers remain paused.

## Local verification

- Clean and released-to-current schema replay, catalog contract, generated types, V2–V5 video rollback fixtures and Phase 9 scoped reads passed with migration 692.
- The video fixture covered an exact-project read by each allowed bot, denial of the marketing bot even with a grant, and denial of a cross-client read.
- Runtime route and gateway adapter tests passed, including rejection of extra request fields and a mismatched project response. The gateway suite, runtime and gateway TypeScript checks, gateway build and parity manifest check passed.

This is source evidence only. There was no hosted migration, bot call against a client, model or render provider execution, human video acceptance or outward switch change. The manual-first video plan and original Phases 8 and 9 remain open.
