import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { useAuth } from "../context/auth";
import { HOME_FOR_ROLE } from "../lib/identity";
import type { ConsoleRole } from "../lib/identity";
import { supabase } from "../lib/supabase";

type Factor = { id: string; type: string; status: string; name: string };
type SecurityState = { factors: Factor[]; aal: "aal1" | "aal2" };
type Enrollment = { id: string; secret: string };

const sessionKeys = new WeakMap<Session, { token: string; key: number }>();
let nextSessionKey = 0;

function opaqueSessionKey(session: Session): number {
  const prior = sessionKeys.get(session);
  if (prior?.token === session.access_token) return prior.key;
  const key = ++nextSessionKey;
  sessionKeys.set(session, { token: session.access_token, key });
  return key;
}

function safeApprovalReturnPath(raw: unknown, role: ConsoleRole): string | null {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  try {
    const url = new URL(raw, "https://console.invalid");
    if (url.origin !== "https://console.invalid") return null;
    const adminInbox = role === "admin" && (url.pathname === "/approvals"
      || /^\/clients\/[a-zA-Z0-9-]+\/delivery\/approval-inbox$/.test(url.pathname));
    const managerInbox = role === "employee" && url.pathname === "/employee/approvals";
    return adminInbox || managerInbox ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}

/** The enrollment secret and verification code exist only in this component's memory. */
export function MfaSecurityPage() {
  const { loading: authLoading, profile, session } = useAuth();
  if (authLoading) return <p className="p-8 text-sm text-muted-foreground">Loading account…</p>;
  if (!profile || !session || profile.id !== session.user.id) return <Navigate to="/login" replace />;

  // An account switch remounts the whole security form before another user's
  // factor names or temporary enrollment secret can be rendered.
  return <MfaSecuritySession key={`${profile.id}:${opaqueSessionKey(session)}`} identity={profile.id} role={profile.role} />;
}

function MfaSecuritySession({ identity, role }: { identity: string; role: ConsoleRole }) {
  const location = useLocation();
  const returnPath = safeApprovalReturnPath((location.state as { returnTo?: unknown } | null)?.returnTo, role);
  const currentIdentity = useRef<string | null>(identity);
  const [security, setSecurity] = useState<SecurityState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (userId: string) => {
    try {
      const [listed, assurance] = await Promise.all([
        supabase.auth.mfa.listFactors(),
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      ]);
      if (listed.error || assurance.error || !listed.data || !assurance.data) {
        throw new Error("security state unavailable");
      }
      if (currentIdentity.current !== userId) return;
      const factors = listed.data.all.map((factor) => ({
        id: factor.id,
        type: factor.factor_type,
        status: factor.status,
        name: factor.friendly_name || "Authenticator app",
      }));
      setSecurity({ factors, aal: assurance.data.currentLevel === "aal2" ? "aal2" : "aal1" });
      setSelectedId((previous) => {
        const available = factors.filter((factor) => factor.status === "verified" && factor.type === "totp");
        return available.some((factor) => factor.id === previous) ? previous : (available[0]?.id ?? "");
      });
      setError(null);
    } catch {
      if (currentIdentity.current === userId) {
        setSecurity(null);
        setError("Could not verify your security settings. Try again before making an approval decision.");
      }
    } finally {
      if (currentIdentity.current === userId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    currentIdentity.current = identity;
    void refresh(identity);
    return () => { currentIdentity.current = null; };
  }, [identity, refresh]);

  const verified = security?.factors.filter((factor) => factor.status === "verified") ?? [];
  const unfinished = security?.factors.filter((factor) => factor.status === "unverified") ?? [];
  const totp = verified.filter((factor) => factor.type === "totp");
  const canEnroll = Boolean(security && unfinished.length === 0 && (verified.length === 0 || security.aal === "aal2"));

  async function startEnrollment() {
    if (!identity || !canEnroll || busy || enrollment) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "AA Console" });
      if (result.error || !result.data?.totp?.secret) throw new Error("enrollment unavailable");
      if (currentIdentity.current !== identity) return;
      setEnrollment({ id: result.data.id, secret: result.data.totp.secret });
      setCode("");
    } catch {
      if (currentIdentity.current === identity) setError("Could not start TOTP setup. An administrator must verify that TOTP enrollment and verification are enabled for this environment.");
    } finally {
      if (currentIdentity.current === identity) setBusy(false);
    }
  }

  async function discardUnfinished(factorId: string) {
    if (busy || !security || !identity || !(unfinished.some((factor) => factor.id === factorId) || enrollment?.id === factorId)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await supabase.auth.mfa.unenroll({ factorId });
      if (result.error) throw new Error("cleanup failed");
      if (currentIdentity.current !== identity) return;
      setEnrollment(null);
      setCode("");
      await refresh(identity);
    } catch {
      if (currentIdentity.current === identity) setError("Could not discard the unfinished factor. Try again before starting another setup.");
    } finally {
      if (currentIdentity.current === identity) setBusy(false);
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!identity || !security || busy) return;
    if (!/^[0-9]{6,8}$/.test(code.trim())) {
      setError("Enter the 6 to 8 digit code from your authenticator app.");
      return;
    }
    const factorId = enrollment?.id ?? selectedId;
    if (!factorId || (!enrollment && !totp.some((factor) => factor.id === factorId))) return;
    setBusy(true);
    setError(null);
    try {
      const result = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
      if (result.error) throw new Error("verification failed");
      if (currentIdentity.current !== identity) return;
      setEnrollment(null);
      setCode("");
      await refresh(identity);
      const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assurance.error || assurance.data.currentLevel !== "aal2") {
        throw new Error("AAL2 not confirmed");
      }
      if (currentIdentity.current === identity) setNotice("Your session now has AAL2. You can return to the Approval Inbox.");
    } catch {
      if (currentIdentity.current === identity) setError("The code was not accepted or AAL2 could not be confirmed. Try again.");
    } finally {
      if (currentIdentity.current === identity) setBusy(false);
    }
  }

  return <main className="mx-auto max-w-xl space-y-6 px-4 py-10 text-foreground">
    <div>
      <h1 className="text-2xl font-semibold">Account security</h1>
      <p className="mt-2 text-sm text-muted-foreground">Use an authenticator app to reach AAL2 before deciding an exact version in the Approval Inbox.</p>
      <Link className="mt-3 inline-block text-sm text-primary underline" to={HOME_FOR_ROLE[role]}>Return to console</Link>
      {returnPath && <Link className="ml-4 inline-block text-sm text-primary underline" to={returnPath}>Return to Approval Inbox</Link>}
    </div>

    {loading && <p role="status" className="text-sm">Checking your factors and session assurance…</p>}
    {error && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="rounded-md border border-border p-3 text-sm">{notice}</p>}

    {security && !loading && <section className="space-y-4 rounded-lg border border-border bg-card p-5">
      <p className="text-sm font-medium">Current session: {security.aal.toUpperCase()}</p>
      <p className="text-sm text-muted-foreground">Verified factors: {verified.length}. Keep a second verified factor available for recovery. If you lose access to every factor, contact an administrator for an identity-verified reset.</p>

      {unfinished.length > 0 && !enrollment && <div className="space-y-2 rounded-md border border-border p-3">
        <p className="text-sm">An unfinished MFA setup exists. Discard it before starting another.</p>
        {unfinished.map((factor) => <button key={factor.id} type="button" disabled={busy}
          onClick={() => void discardUnfinished(factor.id)} className="block text-sm text-primary underline disabled:opacity-50">
          Discard unfinished setup ({factor.name})
        </button>)}
      </div>}

      {security.aal !== "aal2" && verified.length > 0 && <div className="space-y-3">
        <h2 className="font-medium">Complete MFA</h2>
        {totp.length > 0 ? <form onSubmit={verify} className="space-y-3">
          <label className="block text-sm">Authenticator
            <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="mt-1 block w-full rounded-md border border-input bg-background p-2">
              {totp.map((factor) => <option key={factor.id} value={factor.id}>{factor.name}</option>)}
            </select>
          </label>
          <CodeField code={code} onChange={setCode} />
          <button type="submit" disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy ? "Verifying…" : "Verify code"}</button>
        </form> : <p className="text-sm text-destructive">This account has a factor this screen cannot challenge. Contact an administrator for a supported step-up route.</p>}
      </div>}

      {canEnroll && <div className="space-y-3 border-t border-border pt-4">
        <h2 className="font-medium">{verified.length ? "Add a backup authenticator" : "Set up an authenticator"}</h2>
        {!enrollment ? <button type="button" disabled={busy} onClick={() => void startEnrollment()} className="rounded-md border border-input px-4 py-2 text-sm disabled:opacity-50">{busy ? "Starting…" : "Start TOTP setup"}</button> : <>
          <p className="text-sm">Add this one-time setup secret manually to your authenticator app, then enter its current code. The secret is not saved in the Console.</p>
          <code className="block break-all rounded-md bg-muted p-3 text-sm" aria-label="Authenticator setup secret">{enrollment.secret}</code>
          <form onSubmit={verify} className="space-y-3">
            <CodeField code={code} onChange={setCode} />
            <button type="submit" disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy ? "Verifying…" : "Finish TOTP setup"}</button>
            <button type="button" disabled={busy} onClick={() => void discardUnfinished(enrollment.id)} className="ml-3 text-sm text-primary underline disabled:opacity-50">Cancel and discard setup</button>
          </form>
        </>}
      </div>}
    </section>}
  </main>;
}

function CodeField({ code, onChange }: { code: string; onChange: (value: string) => void }) {
  return <label className="block text-sm">One-time code
    <input value={code} onChange={(event) => onChange(event.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,8}" maxLength={8} className="mt-1 block w-full rounded-md border border-input bg-background p-2" />
  </label>;
}
