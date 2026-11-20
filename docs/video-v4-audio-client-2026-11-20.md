# Video V4 audio transport and timing contract — 20 November 2026

The runtime now has a credential-free-to-test ElevenLabs transport boundary.
It requests a single scene's narration from the synchronous
`/v1/text-to-speech/{voice_id}` endpoint with `model_id=eleven_v3` and
`mp3_44100_128`, and sends the returned MP3 plus plain spoken transcript to
`/v1/forced-alignment`. The response must contain ordered, finite word times
and a finite loss score. Provider HTTP errors identify retryable 429/5xx
without printing credential values or provider error bodies. Successful
responses must contain plausible MP3 bytes.

The pure timing helper compares the spoken words with the alignment, checks
each word against the measured audio duration and an **explicit caller-supplied
loss limit**, and emits the renderer's scene timing shape. It holds audio too
long for the compiler's 400 ms tail. It does not pick an unproven loss
threshold, infer a voice ID or claim that audio has been generated.

The request shape follows the official [Create speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert/)
and [Create Forced Alignment](https://elevenlabs.io/docs/api-reference/forced-alignment/create)
references checked on 20 November 2026. The source plan pins Eleven v3;
current provider guidance also describes newer models, so model selection
should be checked against the account before a live run.

Seven focused tests use mocked HTTP responses and no account key. Runtime
typecheck and build passed locally. Stage transitions, voice selection,
Storage, cost receipts, loudness normalization, music, a real aligned audio
fixture and rendering remain open. No external API call or hosted change was
made.
