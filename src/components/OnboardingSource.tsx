import { Link, useParams } from "react-router-dom";

/**
 * A line saying this panel's data is first collected in onboarding.
 *
 * The same rows are written from two places — the step and the panel that
 * owns them — and somebody looking at a half-filled panel has no way to know
 * the other door exists. This is that door, and it points at where the
 * remaining gaps are listed rather than making them hunt.
 *
 * Deliberately a sentence rather than a banner. It is orientation, not a
 * warning: the panel works perfectly well on its own.
 */
export function OnboardingSource({ what }: { what: string }) {
  const { clientId } = useParams<{ clientId: string }>();
  if (!clientId) return null;

  return (
    <p className="mb-4 text-xs text-muted-foreground">
      {what} is first collected in{" "}
      <Link
        to={`/clients/${clientId}/account/onboarding`}
        className="text-brand-strong hover:underline"
      >
        Onboarding
      </Link>
      , which shows what is still missing. Edits here and there are the same record.
    </p>
  );
}
