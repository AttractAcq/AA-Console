# Development execution policy

Use Codex, Claude Code, or Cursor cloud agents for primary development, coding,
and development builds. If a development task arrives in another assistant
environment and can be done in Codex, Claude Code, or a Cursor cloud agent,
explicitly tell Alex to use one of those tools and prepare the handoff there to
conserve usage.
Other assistant environments may coordinate briefs, security review and release gates.

Phase 6 release boundary: prepare code, tests and a reviewable PR; do not merge,
apply production migrations or deploy to Railway without Alex via Chief of Staff.
