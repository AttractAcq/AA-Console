import { DistributionBoard } from "../../components/DistributionBoard";
import { useParams } from "react-router-dom";
import { PaidOperatorBundles } from "./PaidOperatorBundles";
import { MetaAdsReadPanel } from "./MetaAdsReadPanel";

export function PaidPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  return <div className="space-y-5">
    <PaidOperatorBundles clientId={clientId} platform="meta" />
    <MetaAdsReadPanel clientId={clientId} />
    <DistributionBoard channel="paid" />
  </div>;
}
