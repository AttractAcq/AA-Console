import { ConsoleLoginForm } from "../components/ConsoleLoginForm";

export function LoginPage() {
  return (
    <ConsoleLoginForm
      role="admin"
      title="Sign in to AA Console"
      identifierLabel="Email"
      identifierPlaceholder="you@attractacq.com"
      identifierType="email"
    />
  );
}
