# V5 render handoff

`renderProjectAspect` connects the exact audio preflight, service claim, Lambda
start and provider-handle write. A first claim may start one private render.
An existing started claim resumes the stored handle; a claim with no handle or
an uncertain start is held for reconciliation. The function returns a local
downloaded MP4 and attempt identity, leaving probe, critic, candidate filing
and project-stage transition to the next worker step.

The `video_render` agent remains paused and this handoff is not registered in
the runtime dispatcher. Its successful path therefore cannot be mistaken for
a finished, reviewed or attached video. The current attempt receipt records
the region, function, render ID and bucket. The exact renderer site identity
still needs to be stored with the attempt before the live worker is enabled.

Six focused handoff/transport tests and the runtime production build passed
locally. No Lambda call or hosted mutation ran.
