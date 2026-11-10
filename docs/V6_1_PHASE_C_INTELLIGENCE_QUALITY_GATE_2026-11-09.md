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

The legacy ICP form accepted call notes and summaries in `voice_of_customer`, while the prompt labelled the whole field as verbatim customer speech. A read-only production input confirmed that this mismatch is real. The prompt now treats the legacy field as notes that may inform themes but cannot be quoted; the form has a separate verified-verbatim field for exact words with source and date. This fixes the source label, not the output-quality result.

## Historical sample boundary

A local historical export informed the prompt corrections. It predates the current runtime, and its client-specific findings are not part of this repository's review evidence. The current-agent repetition and source-backed claim audit remain open.

## Evidence status

An approved read-only inventory on 10 November found two contrasting candidate context snapshots with one historical ICP and one historical Market output set each. Those runs predate the current prompt and are not independent repetitions. The detailed snapshot contains operator customer-language notes, not verified verbatim speech. Alex chose to treat a separately supplied testimonial and its result claim as unverified notes, so it is excluded from these historical input snapshots. The twelve-trial exercise must check that the model does not turn notes into exact quotations or unsupported measured results. The verified-quote input path is checked by code tests, but this sample cannot demonstrate output quality with a verified quote.

Non-persisting corrective trials on 10 November repeatedly found material source-status errors in ICP output. The most recent single-version batch saved three complete detailed-context ICP repetitions, then stopped after its first repetition expanded a reported revenue amount into an unsupported deal-status claim. The batch had no Market or thin-context outputs and cannot be scored as a passing twelve-run set. Earlier prompt versions and all trial IDs, hashes, outputs and claim classifications remain in the approved private evidence location. The prompt now asks for shorter, source-traceable sections and explicitly prohibits the observed negative-evidence leap. No passing repetition score or current false-claim rate is claimed. Keep the twelve final trial IDs, source snapshots, claim classifications, discrepancies and reviewer decision in an approved private evidence location. Before closing this gate, record only a non-sensitive evidence reference, aggregate results, material failures and the review decision here. Do not paste client source material or client-specific derived findings into this public repository or its PR body.

Further corrective smoke runs found that provider-side proof and operating fields contaminated the buyer portrait, and that ICP question universes omitted the required awareness/comparison/decision stages. The ICP prompt now excludes those provider fields and a runtime check rejects an unstaged question universe before it is saved. A subsequent Market smoke run also failed: it treated an unspecified revenue-target period as monthly, made an unsupported capacity diagnosis from historical operating notes, omitted direct source URLs, and stated an outdated tax threshold. The current threshold is R2.3 million effective 1 April 2026 according to [SARS](https://www.sars.gov.za/faq/what-is-the-new-threshold-for-vat-registration/). Market now requires linked primary evidence, treats the target period and current constraint as unknown without direct evidence, and excludes tax/legal threshold advice. No twelve-run set passes this gate; the raw findings remain private and both release PRs stay drafts.
