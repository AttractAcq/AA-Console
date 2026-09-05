import { useParams } from "react-router-dom";
import { Panel } from "../../components/Panel";
import { useMetrics } from "./useMetrics";

/**
 * Landing and offer page reporting.
 *
 * metrics_daily already has surfaces for these, but nothing writes them:
 * page performance is not an ad-platform source, so it needs its own
 * connector rather than a field added to the Meta one. Saying that plainly
 * is more useful than an empty state that looks like a bug.
 */
export function PagesReportingPanel({ pageType }: { pageType: "landing" | "offer" }) {
  const { clientId } = useParams<{ clientId: string }>();
  const { summary } = useMetrics(clientId, 30);

  const label = pageType === "landing" ? "Landing page" : "Offer page";
  const hasPaid = (summary?.paid.days_covered ?? 0) > 0;

  return (
    <div className="space-y-4">
      <Panel title={`${label} reporting is not connected yet`}>
        <p className="text-sm text-muted-foreground">
          The database is ready for it — <code className="text-xs">metrics_daily</code> already
          carries a {pageType} surface — but nothing writes to it. Page performance comes from site
          analytics rather than the ad platform, so it needs its own connector: the Meta credential
          cannot produce these numbers.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Until then, the pages themselves live under Conversion, and{" "}
          {hasPaid
            ? "paid traffic sent to them is visible in the Paid tab."
            : "the Paid tab will show the traffic sent to them once an ad account is connected."}
        </p>
      </Panel>
    </div>
  );
}
