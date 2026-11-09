# Phase C: Intelligence OS output-quality gate

## Why this is a release gate

The ICP question universe feeds Ideation, and Market, ICP and other Intelligence records feed opportunity discovery, evaluation and strategy. An unsupported claim can therefore become a campaign premise. Code and schema tests cannot establish answer quality; the reviewed output and its source context are required.

## Exercise

Use two contrasting client contexts, each with a reviewed business-context source: one with detailed customer language and one with thin inputs. Run the ICP and Market agents three times per context in a safe test environment or evaluate three independently generated versions per context. Keep run IDs, model/configuration version, input snapshot and output records for each trial. Do not overwrite human-edited production records to create samples.

Review these representative questions in every run:

| Domain | Question the answer must settle | Evidence check |
| --- | --- | --- |
| ICP | Who is the identifiable buyer, what changed to make them buy, and what are they asking at awareness, comparison and decision stages? | Trace assertions and quoted language to the supplied business context or clearly mark an inference. No invented customer quote or demographic certainty. |
| Market | What is the reachable market in the stated geography and period, and is demand or supply the binding constraint? | Every statistic has source, geography, date and units. Recalculate the share-needed arithmetic. Distinguish total, reachable and media-reachable markets. |
| Cross-domain | Does a downstream idea or opportunity use only the current reviewed question universe and market evidence? | Trace its premise to a live record; archived records must be absent. Refuse a missing question universe rather than inventing one. |

For each answer, mark every material claim **supported**, **inference clearly labeled**, **unknown honestly stated**, or **unsupported/false**. A material claim changes target buyer, market size, channel, offer or campaign decision. Check named source links against the source itself; a plausible citation is not enough.

## Acceptance

- Zero unsupported or false **material** claims across the twelve ICP/Market trials; any such claim is a stop, with the prompt or code path fixed and the affected trial repeated.
- Every Market figure used for a decision includes source, geography, period and units; share arithmetic recomputes from the stated inputs.
- All six ICP outputs contain a usable awareness/comparison/decision question universe grounded in the context. Thin context must state its gaps.
- Repetitions may vary wording, but buyer, constraint and market conclusion cannot contradict each other without a changed source or a clearly explained uncertainty.
- A downstream sample from each context traces its premise to current, reviewed records and contains no archived record.

## Code finding addressed in this branch

The shared upstream loader and the direct Intelligence readers in opportunity discovery, evaluation, strategy, offer compilation and creative context did not filter `archived_at`. They now select only active records. A rerun refuses to overwrite an archived template record silently; the operator must restore or replace it explicitly. The rerun check is scoped to the requested period so an archived Q1 record cannot block Q2 or suppress its fresh answer. This is a code-path fix, not evidence that the output-quality exercise has passed.

## Evidence status

The representative production or sanitized output records and their source context are not in this checkout. No repetition score or false-claim rate is claimed yet. Record the twelve trial IDs, source snapshots, claim classifications, discrepancies and reviewer decision here before closing this gate.
