import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ArrowLeftRight } from "lucide-react";
import { useAuth } from "../context/auth";
import { SwitchRoleModal } from "./SwitchRoleModal";
import { HOME_FOR_ROLE } from "../lib/identity";
import type { ConsoleRole } from "../lib/identity";

const ROLE_LABEL: Record<ConsoleRole, string> = {
  admin: "Admin",
  client: "Client",
  employee: "Employee",
};

export function ConsoleLoginForm({
  role,
  title,
  identifierLabel,
  identifierPlaceholder,
  identifierType = "text",
}: {
  role: ConsoleRole;
  title: string;
  identifierLabel: string;
  identifierPlaceholder: string;
  identifierType?: "text" | "email";
}) {
  const { profile, signIn } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);

  // Already signed in — go wherever this account actually belongs.
  if (profile) return <Navigate to={HOME_FOR_ROLE[profile.role]} replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!identifier.trim() || !password) {
      setError(`Enter your ${identifierLabel.toLowerCase()} and password.`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const signedIn = await signIn(identifier, password);
      if (signedIn.role !== role) {
        setError(
          `That is a ${ROLE_LABEL[signedIn.role]} account. Use the ${ROLE_LABEL[signedIn.role]} sign-in.`,
        );
        setBusy(false);
        return;
      }
      navigate(HOME_FOR_ROLE[signedIn.role], { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
            AA
          </div>
          <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm"
        >
          <div className="space-y-1.5">
            <label htmlFor="identifier" className="text-sm font-medium text-foreground">
              {identifierLabel}
            </label>
            <input
              id="identifier"
              type={identifierType}
              autoComplete={identifierType === "email" ? "email" : "username"}
              autoCapitalize="none"
              spellCheck={false}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder={identifierPlaceholder}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium text-foreground">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {busy ? "Signing in…" : "Log in"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => setSwitchOpen(true)}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
          Switch
        </button>
      </div>

      <SwitchRoleModal open={switchOpen} onClose={() => setSwitchOpen(false)} exclude={role} />
    </div>
  );
}
