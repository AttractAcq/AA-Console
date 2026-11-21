# Local three-aspect gold-render review — 21 November 2026

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

The same nine-scene fixture also rendered locally as 16:9 and 1:1 MP4s at PR
head `1d9762b26354071da91f7c7ab9ae57dc90279a75`, using installed Chrome
and `npm run render:gold -- 16:9 1:1`. Both processes exited 0.

| Aspect | MP4 and SHA-256 | Contact sheet and SHA-256 | Probe |
|---|---|---|---|
| 16:9 | [MP4](/Users/alex/Desktop/AA-video-gold-16x9-review-2026-11-21.mp4) `8a385a9d6f9b83ce42b7775779efd24ddaffef1007b04f19ae96903977700c9f` | [Nine frames](/Users/alex/Desktop/AA-video-gold-16x9-contact-sheet-2026-11-21.png) `f185bffa1030e70b13bef97b24d5eeab031fe955e984668e07cc5b220acf8416` | H.264, 1920×1080, 120.000 seconds; video stream only |
| 1:1 | [MP4](/Users/alex/Desktop/AA-video-gold-1x1-review-2026-11-21.mp4) `676a61c24bf4484aefcaa1e37cc7c7f2e4e6836b1e271ab561ae5e7881450cc3` | [Nine frames](/Users/alex/Desktop/AA-video-gold-1x1-contact-sheet-2026-11-21.png) `62bd62d501e2e1df9ab365d9f51d04336ef08d3af2741f0325b8badb9eb2571d` | H.264, 1080×1080, 120.000 seconds; video stream only |

The sampled landscape and square frames show no visible clipping and retain
the same visual language. Landscape has generous empty space and small detail
labels; a person still needs to judge pacing and legibility at playback size.
These are silent fixture renders, not prompt-to-finished client videos.

The first attempt tried to download Chrome Headless Shell and failed because
`remotion.media` did not resolve in this environment. The installed Chrome
binary initially aborted under the sandbox; the same render completed with
local browser-launch access. No rendering source was changed to make it pass.

Remaining gate: review the motion and legibility in the MP4, then run one
scoped client brief through script, audio, render, exact Storage read-back,
candidate review, attachment and human asset approval using licensed accounts.
Keep outward switches off and Phases 8/9 unaccepted until their evidence exists.
