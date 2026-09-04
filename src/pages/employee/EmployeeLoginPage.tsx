import { ConsoleLoginForm } from "../../components/ConsoleLoginForm";

export function EmployeeLoginPage() {
  return (
    <ConsoleLoginForm
      role="employee"
      title="Sign in to AA Employee Console"
      identifierLabel="Username"
      identifierPlaceholder="SMM1"
    />
  );
}
