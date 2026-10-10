# Phase 2.1 — Opus 5.5 against Fable 5.1 on the editor

Run on 10 October 2026 against the one reel in the system that has clips.
Both models planned the same six Higgsfield clips from the same brief, through
`spike.ts --model`, at the sampling the agent actually uses.

**The headline is not which model won.** It is that the first comparison
measured a defect in our own prompt, and fixing it removed most of the gap.

---

## What the first run appeared to show

| | Opus 5.5 | Fable 5.1 |
|---|---|---|
| Validator problems on the first plan | 0 | **2** |
| Cost per cut | $0.1447 | **$0.4217** |

Fable looked 2.9× the price. The roadmap predicted exactly this failure mode —
"a model that produces plans the validator refuses is expensive twice" — because
a revise replays the whole first attempt, and the input tokens double.

But the two problems were worth reading rather than scoring:

1. Fable returned `end_card_sec: 22.8`, the end card's **start time**, where
   the field means its **duration**.
2. Fable returned a 70-character end card against a 60-character limit.

## Both were our fault

**`end_card_sec` had no description.** Every other field in `EDL_SCHEMA` had
one. And it sits beside `in_sec`, `out_sec`, `start_sec` and `end_sec` — four
fields that are all *positions on a timeline*. Reading the fifth as a position
is the consistent reading of the schema we wrote.

**The 60-character limit was never stated.** `MAX_CAPTION_CHARS` and
`MAX_END_CARD_SEC` appeared only inside `validateEdl`. The planner was graded
on rules it was never given, and could only discover them by failing — at the
cost of a full revise round.

Both are fixed: `end_card_sec` now says "a duration, not a time on the reel",
and the user turn states the character limit, the end card range and the
transition set, all interpolated from the same constants the validator uses.

## What the comparison shows once the prompt is honest

| | Opus 5.5 | Fable 5.1 |
|---|---|---|
| Validator problems | 0 | **0** |
| Input / output tokens | 13,806 / 2,925 | 13,806 / 1,615 |
| **Cost per cut** | **$0.1422** | $0.2188 |
| Wall clock | 39.8s | **21.8s** |
| Captions | 0 | 0 |
| End card | 50 chars, identical | 50 chars, identical |
| Runtime against the 26s cap | 24.98s | 25.40s |

Fable's cost fell 48%, from $0.4217 to $0.2188, on a prompt change alone.

Opus remains cheaper, but not for a quality reason: Fable is $10/$50 per MTok
against Opus's $5/$25, so Fable costs 1.54× as much while using *fewer* output
tokens. Fable is also 1.8× faster.

Both suppressed captions entirely, and both were right to: every shot has its
line burned into the artwork, and a caption would put a second typeface on top
of the first. That is the judgement the prompt cares most about and both models
make it.

---

## The one real difference, and it is verifiable

**Fable does not use the sampled frames to choose in-points.** Across three
runs it started all six segments at 0.00 — 0 of 6 trimmed, every time. Opus
trimmed in all three runs, and always the same shot.

| Run | Segments starting after 0.00 |
|---|---|
| `fable` ×3 | 0/6, 0/6, 0/6 |
| `opus` ×3 | 3/6, 1/6, 1/6 |

Opus's consistent trim is shot 2, which it opens at 2.0s. The frames say why:

```
0.0s   1.2s   1.8s        2.4s          3.0s
hand placing the report   hand clears   node graph draws itself
```

The beat is "activity you could not trace back to a single job" — the graph
drawing itself *is* the beat. Opus opens on it. Fable opens on two seconds of
a hand retreating, then reaches the content. The system prompt says "Open on
the strongest frame, not the first one". Opus follows it; Fable does not.

This is the finding that would decide the choice, and it is not a cost
argument.

---

## What this does not establish

Three limits, stated plainly because the roadmap asked for five reels:

1. **It is one brief, not five.** All three reel assets in production share the
   same brief, and two have zero clips submitted. The 3–5 reels the roadmap
   specified do not exist. What is n=3 here is *runs per model*, not briefs —
   enough to show the in-point behaviour is systematic rather than a draw,
   not enough to show it generalises.
2. **Approval rate is unmeasured, and was the headline metric.** It needs
   rendered files and Alex's judgement. Rendering is blocked locally: Homebrew
   ffmpeg 8.1 ships without `--enable-libfreetype`, so `drawtext` is absent.
   Every figure above is from the plan, not a finished cut.
3. **The brand check is inert for this client.** The `banned_phrases` derived
   from this client's `never_do` are instructions — "No neon greens", "Do not
   replace the wordmark" — not literal strings a caption would contain. The
   substring check cannot fire on them. Worth knowing before anyone reads a
   clean brand result as a pass.

## On the roadmap's $0.19 figure

It was right. Production's three cuts averaged $0.1902 on 18,266 input tokens,
and Opus here cost $0.1422 on 13,806 — the difference is clip length, not
method. What was wrong was my first spike run, which reported $0.5704 for a
single cut because `spike.ts` defaulted to `--fps 2` and a hardcoded width of
512 where the agent samples at 1 fps and 384px. The spike was pricing a job the
agent does not run. Its defaults now match the agent and `--width` is a flag.

## Recommendation

**Stay on Opus 5.5**, on the in-point evidence rather than the cost: it is
cheaper, and it is the one that reads the footage. Revisit if Fable's 1.8×
speed ever matters, or once more than one brief exists to test against.

The portable result is the prompt fix. It cost nothing, it helps whichever
model runs, and it was only visible because two models disagreed.
