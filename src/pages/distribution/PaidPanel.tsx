import { DistributionBoard } from "../../components/DistributionBoard";
import { useParams } from "react-router-dom";
import { PaidOperatorBundles } from "./PaidOperatorBundles";

export function PaidPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  return <div className="space-y-5">
    <PaidOperatorBundles clientId={clientId} platform="meta" />
    <DistributionBoard channel="paid" />
  </div>;
}
