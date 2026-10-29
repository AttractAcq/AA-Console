import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { toEmail } from "../lib/identity";
import type { ConsoleRole, EmployeeCategory } from "../lib/identity";
import { syncDraftIdentity } from "../components/forms/draftStorage";

export type Profile = {
  id: string;
  role: ConsoleRole;
  full_name: string | null;
  email: string | null;
  employee_category: EmployeeCategory | null;
  /** The client this user belongs to, for role === "client". */
  client_id: string | null;
  /** The team_members row for this user, for role === "employee". */
  member_id: string | null;
};

type AuthContextValue = {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  isAuthenticated: boolean;
  signIn: (identifier: string, password: string) => Promise<Profile>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

async function loadProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, role, full_name, email, employee_category")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return null;

  // Resolve the two scoping ids the consoles need. Both are optional:
  // an admin has neither, a client has the first, an employee the second.
  const [{ data: link }, { data: member }] = await Promise.all([
    supabase.from("client_users").select("client_id").eq("user_id", userId).maybeSingle(),
    supabase.from("team_members").select("id").eq("user_id", userId).maybeSingle(),
  ]);
  if (data.role === "employee" && !member) return null;

  return {
    id: data.id,
    role: data.role as ConsoleRole,
    full_name: data.full_name,
    email: data.email,
    employee_category: data.employee_category as EmployeeCategory | null,
    client_id: link?.client_id ?? null,
    member_id: member?.id ?? null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const activeUserId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let authEventSeen = false;
    let requestId = 0;

    function applySession(next: Session | null) {
      const userId = next?.user.id ?? null;
      const changedUser = activeUserId.current !== userId;
      const request = ++requestId;
      activeUserId.current = userId;
      syncDraftIdentity(userId);
      setSession(next);
      if (!userId) {
        setProfile(null);
        setLoading(false);
        return;
      }
      if (changedUser) {
        // Do not render the previous account's console while the new profile
        // loads. A same-role account switch can keep the same route mounted.
        setProfile(null);
        setLoading(true);
      }
      void loadProfile(userId).then((loaded) => {
        if (cancelled || request !== requestId || activeUserId.current !== userId) return;
        setProfile(loaded);
        setLoading(false);
      });
    }

    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled && !authEventSeen) applySession(data.session);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      authEventSeen = true;
      if (!cancelled) applySession(next);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (identifier: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: toEmail(identifier),
      password,
    });
    if (error) throw new Error("Those details don't match an account.");
    activeUserId.current = data.user.id;
    syncDraftIdentity(data.user.id);
    setSession(data.session);
    setProfile(null);
    setLoading(true);

    const loaded = await loadProfile(data.user.id);
    if (activeUserId.current !== data.user.id) {
      throw new Error("The signed-in account changed. Try again.");
    }
    if (!loaded) {
      await supabase.auth.signOut();
      throw new Error("This account is unavailable. Ask an admin to check your team profile.");
    }
    setProfile(loaded);
    setLoading(false);
    return loaded;
  }, []);

  const signOut = useCallback(async () => {
    syncDraftIdentity(null);
    await supabase.auth.signOut();
    activeUserId.current = null;
    setSession(null);
    setProfile(null);
  }, []);

  const value = useMemo(
    () => ({
      session,
      profile,
      loading,
      isAuthenticated: session !== null && profile?.id === session.user.id,
      signIn,
      signOut,
    }),
    [session, profile, loading, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
