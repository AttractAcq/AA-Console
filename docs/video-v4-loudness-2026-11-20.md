# Video V4 measured loudness — 20 November 2026

The audio stage now has a local FFmpeg helper to measure integrated loudness,
normalise an MP3 with two-pass `loudnorm`, probe the resulting audio duration
and verify that the output is within 1 LU of the requested target. It accepts
an explicit target between -30 and -10 LUFS; the planned narration and music
targets are -16 and -24 respectively. It uses `execFile` arguments, not a
shell, and places the finished file with an atomic no-overwrite hard link so
a concurrent retry cannot silently replace earlier bytes.

A real local four-second sine MP3 fixture normalised to -16 LUFS and passed
the duration and no-overwrite checks. Runtime typecheck and build passed.
This is local processing only. No ElevenLabs request, client Storage write,
scene alignment, cost receipt or finished video has occurred. The helper
does not trim leading silence or mix music; those are separate stage gates.
