import { ConsoleLoginForm } from "../../components/ConsoleLoginForm";

export function ClientLoginPage() {
  return (
    <ConsoleLoginForm
      role="client"
      title="Sign in to AA Client Console"
      identifierLabel="Username"
      identifierPlaceholder="AttractAcquisition"
    />
  );
}
