# Local vertical gold-render review — 21 November 2026

Source: `video-render/fixtures/ir/gold-01.json` at PR #434 head
`c043b9ec6d3291091022110c52d29a50ddfae6a7`. Command:
`AA_REMOTION_BROWSER=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome AA_VIDEO_OUT_DIR=/private/tmp/aa-video-gold-review npm run render:gold -- 9:16`.
Remotion used installed local Chrome; no Lambda, ElevenLabs, Storage or hosted
provider was called.

- [Review MP4](/Users/alex/Desktop/AA-video-gold-9x16-review-2026-11-21.mp4):
  SHA-256 `65257725e16e3316b7383db6de19012e15030d2a862298b79a369814158f70a8`.
  `ffprobe` reported H.264, 1080×1920 and 120.000 seconds. The process exited 0.
- [Nine-frame contact sheet](/Users/alex/Desktop/AA-video-gold-9x16-contact-sheet-2026-11-21.png):
  SHA-256 `923664706a3bb7ee6e7ea605d344d5acab5193619c43e2f78e3073970e952652`.
  Representative samples across nine scenes show unclipped text, visible
  contrast and consistent green/cream typography and diagrams. The comparison
  and flow scenes contain small labels; their actual mobile playback needs a
  human readability judgment.
- `ffprobe` found **no audio stream**. The gold fixture proves the local visual
  renderer, not narration, music, synchronization or the provider-to-Storage
  receipt path. It also is not an approved client asset or publishable item.

The first attempt tried to download Chrome Headless Shell and failed because
`remotion.media` did not resolve in this environment. The installed Chrome
binary initially aborted under the sandbox; the same render completed with
local browser-launch access. No rendering source was changed to make it pass.

Remaining gate: review the motion and legibility in the MP4, then run one
scoped client brief through script, audio, render, exact Storage read-back,
candidate review, attachment and human asset approval using licensed accounts.
Keep outward switches off and Phases 8/9 unaccepted until their evidence exists.
