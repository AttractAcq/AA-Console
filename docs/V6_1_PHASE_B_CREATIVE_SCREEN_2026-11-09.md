# v6.1 Phase B: creative screen and visual target

## Product decision

Harbour Dental's image briefs and AA's paid Meta statics are **image-led by default**: a real scene or photograph carries the idea, with the words over it. A typography card is appropriate when the approved brief explicitly requests one. This includes Harbour's older “Type only” quote graphics and carousels; those should not be silently converted into photographs. The runtime now reads `client_briefs.visual_direction`, which it previously omitted, and passes the decision to concept validation and rendering.

The production data does not reliably mark “paid Meta” as a separate route: AA's static briefs have a mix of null and Instagram `target_platform` values, while `acquisition_route` is unpopulated in the inspected idea rows. The image-led default therefore applies to static image briefs generally, and an explicit card instruction remains the exception. Any future paid-only rule needs a typed source field.

Six Harbour render PNGs were opened: five are card-dominant (two have a photograph confined to the upper part) and one is a photograph-led scene. The linked asset readback shows only three of those paths filed: a card pending review, a photo rejected, and another card approved. The decision above guides future generation; it does not undo the human approval. One unfiled raw render visibly carries a different practice name and phone number. That identity defect is separate from the composition screen and should be checked before any reuse of the old render.

## Pixel calibration

The original screen counted only flat light blocks. Its three claimed “image-led controls” were dark typography cards. A local audit measured 161 production PNGs, including all 47 AA V2 renders, and visually reviewed 63 frames with at least 15% flat dark area and under 10% flat light area. These are real generated frames, not synthetic control images.

The 15–70% dark band contains both cards and photographs. In the reviewed contact sheets, a V2 dark text card had about 57% flat dark area, while genuine dark object photographs reached 66–83%. A single dark cutoff cannot truthfully assign `card_led`. The repaired screen records light and dark fractions separately and uses `dark_review` as an observational warning from 15% dark flatness. It says explicitly that a dark photograph can measure the same way. No dark render is refused on this signal. Bright card detection remains observational and its note no longer claims that flatness proves a card.

The regression test now measures eight small PNG fixtures downscaled from the opened production pixels. Their source suffixes and human labels are recorded beside the fixtures. The paired dark card and dark photograph at about 32% flat-dark area make the overlap executable evidence rather than a claim based only on numeric mocks.

## Almost-empty frame

The opened production story frame `.../cc3a2f22-f425-486e-890e-637a55b877e0/01.png` is essentially white with a sliver of a green object at the left: 97.45% flat light area, mean luminance 241.1. Frame `06.png` of the same story has a clear row of eight objects despite 84.61% flat light area and mean luminance 231.0. The guard uses at least 95% flat light **and** mean luminance at least 235. It stops a matching render before storage and returns a nonretryable job failure so an automatic retry cannot repeatedly buy the same blank output. The operator can rebuild the frame. This deliberately narrow criterion is not a general aesthetic test.

## Open work

The offered direct pixel measurement of all 66 frames remains open, as requested. The 161-PNG audit above is a different render cohort and does not close it. If this screen is ever made into a broader automatic refusal gate, card versus photograph needs a stronger labelled visual classifier; flatness alone is insufficient.
