# Video V3 runtime IR preflight — 20 November 2026

The renderer owns the Zod IR and component prop schemas. Its exporter copies
the derived JSON Schema and a pure semantic validator into the agent runtime.
The runtime uses AJV 2020 for component shape and the byte-identical semantic
module for scene sequence, aspect uniqueness, visible prose, transitions,
literal colours, and component refinements that JSON Schema cannot express.
The copy test fails if the semantic source or generated schema drifts.

This makes a writing agent able to reject malformed IR before storing or
sending it to the renderer. It does not make model output correct, sourced, or
renderable. Zod string transformations and the timeline compiler still run in
the renderer and can reject a runtime-preflighted plan. The final worker must
call the renderer's validation/compile boundary and record those results; this
runtime gate alone is not a V3 pass or a human approval.

Local checks: renderer build and 21 tests; agent-runtime typecheck, build,
the two contract/validation test files (9 tests), and a built-module import.
No provider call, database row, hosted render, switch or deployment changed.
