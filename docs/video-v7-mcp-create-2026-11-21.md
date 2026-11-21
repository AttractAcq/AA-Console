# V7 source-bound MCP video start

`content.create_video_project` lets only the Production bot start a code-rendered video. The gateway and runtime accept a typed idea, audience, tone, length, aspects, one to twelve reviewed model-source IDs, and optional approved video brief plus current campaign route. The request carries an idempotency key. The database independently checks the active bot, exact client grant, permission, source review state, brief and route before it writes.

One transaction creates the project, freezes its reviewed source packet and digest, and queues `video_script`. A paused script agent, stale route or invalid source leaves no project or job. A same-key retry returns the original project/job; changed input with that key is refused. The project records its Production-bot origin and the job records MCP request and execution IDs. This path cannot approve an asset or publish it. The existing human draft/start path remains available.

The video script agent is still paused in the reviewed release, so this API will return `video_agent_unavailable` until a separately reviewed activation enables it. Later script, audio and render workers and exact human review remain distinct gates. A queued job is not a finished animation.

## Verification

- Disposable clean and released-to-current database replay, generated types, catalog and rollback fixtures must pass on the exact source before release.
- The new rollback fixture covers paused-worker atomicity, wrong bot/client, cross-client source, unrelated campaign brief, current source snapshot and route, idempotent retry and changed-key conflict.
- Local HTTP route and gateway tests cover strict inputs, hard Production-bot policy and bound response. Full gateway, runtime TypeScript and source CI are required before merge.

No hosted migration, model or renderer call, agent activation, approval, outward action or Phase 8/9 acceptance is included.
