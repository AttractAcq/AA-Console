import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { PageBuilderPanel } from "../conversion/PageBuilderPanel";

/**
 * The pages a hiring ad points at.
 *
 * Page Builder, aimed at Attract Acquisition's own hiring instead of a
 * client's campaigns. It is the same panel because it is the same job — brief
 * it, let the agent build it, review the HTML, publish it — and a second
 * implementation would drift from the first within a month.
 *
 * Two things make it different, and both are handled by the panel itself: the
 * pages are page_type 'recruitment', so they never appear in a client's Page
 * Builder; and there is no campaign to attach one to, because AA is not
 * running a campaign for itself, it is filling a role.
 *
 * The client has to be resolved here because Team is not a client-scoped
 * route. There is no clientId in the URL to read, and recruitment work always
 * belongs to the house client — the same rule migration 94 enforces for
 * recruitment briefs.
 */
export function RecruitmentPagesPanel() {
  const [houseClientId, setHouseClientId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.rpc("aa_house_client_id");
      if (cancelled) return;
      if (error || !data) {
        setProblem(
          error?.message ?? "The Attract Acquisition house client is missing, so there is nowhere to keep these pages.",
        );
      } else {
        setHouseClientId(data as string);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (problem || !houseClientId) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {problem ?? "No house client."}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Landing pages for Attract Acquisition's own hiring — where a recruitment ad sends an
        applicant. Kept separate from client pages, and not linked to any campaign.
      </p>
      <PageBuilderPanel pageType="recruitment" clientId={houseClientId} />
    </div>
  );
}
