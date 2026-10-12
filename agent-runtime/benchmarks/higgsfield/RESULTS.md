# Synthetic Higgsfield comparison — 12 October 2026

This is a paid, controlled provider check with a **fictional generated image**, not client media. The two routes received the same opening still and prompt within each pair. The first prompt was invalid for the image: it asked the potter to lift a dark finished vase, while the opening frame showed an unfinished terracotta vase on the wheel. Those outputs are retained as a prompt-grounding failure, not as a fair model winner. The second prompt kept the vase on the wheel and requested a physically plausible continuation.

| Pair | Model | Provider request | Time to completed status | File | Sampled-frame finding |
|---|---|---|---:|---|---|
| Initial, contradictory | Kling 2.5 Turbo Pro | `0a1b70c8-704d-4572-82c2-3a6aa0dd1970` | 4m 02s | 1080 × 1916, 5.04s | Lifts the unfinished vase off a spinning wheel; implausible action. |
| Initial, contradictory | Kling 3.0 4K | `3c41ea9f-ee88-43ca-b9ca-e52eddf81f77` | 3m 13s | 2160 × 3836, 5.04s | Changes terracotta into a dark finished vase; material and state drift. |
| Image-anchored | Kling 2.5 Turbo Pro | `7647dbb0-1466-4241-b8e5-55f50263c7ec` | 3m 37s | 1080 × 1916, 5.04s | More visible hand motion, but sampled frames show a hand/tool continuity concern. |
| Image-anchored | Kling 3.0 4K | `666f524a-56b9-4d65-82a2-b1ebbc68a310` | 3m 36s | 2160 × 3836, 5.04s | Better sampled-frame identity, material and scene stability; action is subtle. |

The files were inspected locally with `ffprobe` and one-frame-per-second contact sheets. The [2.5 anchored sheet](v25-anchored-contact.jpg) and [3.0 anchored sheet](v30-anchored-contact.jpg) support the comparison; the [initial 2.5 sheet](v25-contact.jpg) and [initial 3.0 sheet](v30-contact.jpg) show why the first prompt was rejected. The actual MP4s remain local and are excluded from Git. A sampled contact sheet cannot certify a full-cut creative verdict or sound, which was deliberately off for this comparison.

**Decision:** keep the configured 2.5 Pro production route until a complete F6 and F7 reel, including edits, captions, sound and owner/SMM review, is accepted. Carry 3.0 4K as the leading fidelity candidate for that test. The initial-prompt failure led to a production prompt rule that grounds motion in the opening frame. Ambiguous provider submissions now carry a stable idempotency key, following [Higgsfield's request lifecycle](https://docs.higgsfield.ai/docs/concepts/requests) and [idempotency contract](https://docs.higgsfield.ai/docs/concepts/idempotency).

The provider's responses used here did not include per-request charges. Actual charged amounts must be read from the account billing/analytics view; published model rates are estimates and were not substituted for account evidence.
