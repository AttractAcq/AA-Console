# Archived surfaces, v6.1

Alex on 31 October, on archiving: *"make sure we are keeping a list of
everything that is actively archived becasue this is a bad habit and a way to
make the repo messy. we will have to clean up in v6.2 once v6.1 is live and
working, but for now, archive and document."*

So this is the list. **Archived means the way in is gone and the code is not.**
Each panel below still compiles and still has its tests, so v6.2 can delete it
without reopening the decision — and so that reinstating one is a single line
rather than an archaeology exercise.

## Archived in v6.1

| Surface | Where the code still is | Why |
|---|---|---|
| Proof Distribution → **Placements** | `src/pages/proof-distribution/ProofDistributionPanel.tsx` | The notes: "placement is not as important and I believe both need to be discontinued." |
| Proof Distribution → **Rights** | same panel | The notes: "Rights tab is not as important." |
| Lead Magnet Studio → **Opt-ins** | `src/pages/lead-magnet/LeadMagnetStudioPanel.tsx` | The notes: "The opt ins isnt necissary to track, and it all needs to be compiled into the single page functionality." |

Removed from `src/config/navigation.ts` only. `src/config/navigation.test.ts`
pins the remaining tab lists, so a reinstated tab fails a test rather than
arriving unnoticed in a merge.

## Explicitly *not* archived

**Motion Design** stays exactly as it is. The notes say "This page can be left
alone for now as I believe we will discontinue it" — left alone, not removed.
An earlier draft of the v6.1 plan listed it for archiving in 0.3 while also
listing it as deferred, which contradicted the notes and itself; the plan now
says deferred in both places. It is a candidate for v6.2, on Alex's word rather
than inference.

## What replaces them

Neither Proof Distribution tab leaves a gap. The notes ask for that module to
become two tabs: **Destinations**, with the ten destinations as individual
connect-modules in the shape of the Proof Production capture methods, and a
**Distribution Log** showing what went where and when. Destinations survives
here; the log arrives in Phase 4 of the build plan.

Opt-ins likewise folds into the single-page Lead Magnet Studio of Phase 3,
which is a table of magnets plus one build button.

## For v6.2

Delete the archived panel code and its tests, and with it any now-unreferenced
query, type or RPC each used alone. Check first that the Distribution Log has
genuinely replaced what Placements showed, so nothing a person relied on
disappears with the file.
