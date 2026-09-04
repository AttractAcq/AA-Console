import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { toEmail } from "../lib/identity";
import type { ConsoleRole, EmployeeCategory } from "../lib/identity";

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

  useEffect(() => {
    let cancelled = false;

    void supabase.auth.getSession().then(async ({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      if (data.session) setProfile(await loadProfile(data.session.user.id));
      if (!cancelled) setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        setProfile(null);
        return;
      }
      void loadProfile(next.user.id).then((p) => {
        if (!cancelled) setProfile(p);
      });
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

    const loaded = await loadProfile(data.user.id);
    if (!loaded) {
      await supabase.auth.signOut();
      throw new Error("This account has no profile. Ask an admin to set it up.");
    }
    setProfile(loaded);
    return loaded;
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
  }, []);

  const value = useMemo(
    () => ({
      session,
      profile,
      loading,
      isAuthenticated: session !== null && profile !== null,
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
