# V4 narration finishing

This source slice finishes each generated scene MP3 before forced alignment:

- Detect an initial silence of at least 150 ms at -50 dB. Trim that pause only when it begins at the file start; retain shorter pauses. Reject a file with no usable audio after the pause.
- Measure and normalize the trimmed signal with two-pass FFmpeg `loudnorm` to -16 LUFS, include a 400 ms silence tail, and file the resulting MP3 without overwriting another attempt.
- Align the actual finished MP3, store its probed duration and hash, and let the renderer count the physical tail exactly once. Silent development fixtures still receive a compiler-supplied visual tail.
- Permit a finished scene file up to 25 seconds, the renderer's scene ceiling.

A local FFmpeg fixture with a 350 ms leading pause and two seconds of tone produces a roughly 2.4-second file with one trailing silent region. A 100 ms pause remains. Focused runtime audio/timing tests, renderer compiler tests, runtime typecheck and renderer build passed locally. The test does not establish word-level alignment quality or one-frame caption sync over a full finished video. No ElevenLabs request, Storage write, hosted migration, provider charge, release or outward switch change occurred.

Remaining V4 work includes optional music filing and failure receipt, cost reconciliation, exact project timing assembly and full-video caption drift acceptance. V5–V8 and Phases 8/9 remain open.
