# Delivery flows — index

Memos for delivering AA Console's own service, the Client Acquisition System. Each one is
written to be followed by a person, start to finish, without asking anyone a question.

- **Map and rationale:** [`../core-delivery-flows-map.md`](../core-delivery-flows-map.md)
- **Main flows** (multi-process, span modules): [`main/`](main/) — MF01–MF16
- **Secondary flows** (one task each): [`secondary/`](secondary/) — SF01–SF82
- **Conventions used by every memo:** [`CONVENTIONS.md`](CONVENTIONS.md)

## Main flows

| ID | Flow | Layer |
|---|---|---|
| [MF01](main/MF01-client-activation.md) | Client activation | Foundation |
| [MF02](main/MF02-opportunity-to-activation.md) | Opportunity to activation | Foundation |
| [MF03](main/MF03-campaign-build-organic.md) | Campaign build, organic mode | Attract / Nurture |
| [MF04](main/MF04-campaign-build-paid-meta.md) | Campaign build, paid mode (Meta) | Attract |
| [MF05](main/MF05-campaign-build-paid-google.md) | Campaign build, paid mode (Google) | Attract |
| [MF06](main/MF06-proof-to-omnipresence.md) | Proof to omnipresence | Nurture |
| [MF07](main/MF07-produce-video-with-ai.md) | Produce a video with AI | Nurture |
| [MF08](main/MF08-produce-content-with-people.md) | Produce content with people | Nurture |
| [MF09](main/MF09-run-the-content-engine.md) | Run the organic content engine | Nurture |
| [MF10](main/MF10-attract-nurture-convert.md) | Attract → nurture → convert for one micro-niche | All three |
| [MF11](main/MF11-build-the-conversion-path.md) | Build the conversion path | Convert |
| [MF12](main/MF12-sales-path.md) | Sales path | Convert |
| [MF13](main/MF13-attribution-and-learning.md) | Attribution and the learning loop | Measure |
| [MF14](main/MF14-recruitment.md) | Recruitment | Internal |
| [MF15](main/MF15-offer-change-and-drift.md) | Offer change and drift sweep | Lifecycle |
| [MF16](main/MF16-campaign-lifecycle.md) | Campaign lifecycle | Lifecycle |

## Secondary flows

Numbered SF01–SF82 and grouped by the module that owns the job. See
[`secondary/README.md`](secondary/README.md) for the full list.

## Reading order for someone new

1. `CONVENTIONS.md` — the four-switch rule and how to read a `_due` view. Ten minutes,
   and it makes every other memo shorter.
2. MF01, then MF02. Nothing else runs until a client is activated and an opportunity approved.
3. MF10. The flagship journey, which puts every other flow in context.
4. Then whichever build track the client is on: MF03 (organic) or MF04 (paid Meta).
