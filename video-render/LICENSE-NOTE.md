# Remotion licence decision

**Status, 21 November 2026:** AA's headcount and any Remotion Company License
have not been verified in this repository. The local gold MP4s are evaluation
fixtures; no production render service or paid Remotion account is established.
This note does not attest that AA qualifies for any licence tier. The linked
Remotion pricing and FAQ were rechecked on 21 November 2026 for the 4.x
renderer pinned in this package.

The [official pricing](https://www.remotion.dev/docs/license/pricing) and
[FAQ](https://www.remotion.dev/docs/license/faq) say individuals and
organizations of up to three people may use Remotion free, including
commercial automation. Eligibility uses the organization's total headcount,
not only the people operating Remotion. An organization outside that category
needs a Company License. The FAQ classifies automated server rendering and
prompt-to-video products under Automators, listed at $0.01 per render with a
$100 monthly minimum. The Creators seat option is for low-volume creation
without automation. The [4.0 terms](https://www.remotion.dev/docs/terms-4-0)
apply to this pinned Remotion 4.x package; the generic
[`/docs/terms`](https://www.remotion.dev/docs/terms) page now displays
**upcoming** 5.0 terms. Check the current pricing, FAQ and applicable terms
again before purchase or release because eligibility and pricing can change.

Before provisioning the production Lambda function, Alex or the licence owner
must establish AA's actual eligibility and record the decision here. The
release command requires both `AA_REMOTION_LICENSE_CONFIRMED=1` and a
non-secret `AA_REMOTION_LICENSE_BASIS`:

- `free-up-to-three`: AA confirms the whole qualifying organization/team has
  at most three people under the current Free License terms.
- `company-automators`: AA confirms an active Company License covering the
  prompt-to-video automation. Record the licence custodian and date in the
  release evidence, without copying account credentials into source.

The environment variables are a deliberate operator attestation, not proof
of headcount or purchase. The script's read-only plan remains available before
the decision; `--execute` rejects a missing or unsupported basis. AWS Lambda,
S3 and model/audio usage have separate charges and prerequisites.

The explanation icon allow-list uses `lucide-react` (ISC); its package licence remains bundled in `node_modules` during development and must be retained in distribution notices if the renderer is packaged for deployment.
