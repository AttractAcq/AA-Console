# V5 render input preflight

`buildVideoRenderInputs` accepts only a `timed` project with an exact validated
IR. It uses the existing service-only audio completion RPC to recheck scene
receipts and Storage object identities, reads the terminal music outcome,
downloads each filed MP3 and compares byte length and SHA-256 with its receipt.
It then creates two-hour signed media URLs, assembles the renderer timing props,
repeats the completion check, and confirms the project IR and music path did not
change during preparation.

The preflight is not yet called by a render worker. An object could change after
this function returns; the later render attempt and final candidate filing must
have their own identity/readback checks. This function makes no provider call
and does not change a project stage or outward switch.

Focused preflight tests and the runtime production build passed locally. No
rendered candidate or hosted evidence exists from this slice.
