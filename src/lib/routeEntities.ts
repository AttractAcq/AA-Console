import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "./supabase";
import type { TeamCategory } from "../data/team";

export type RouteScope = {
  clientId?: string;
  category?: TeamCategory;
  memberId?: string;
  agentId?: string;
};

function isCategory(v: string | undefined): v is TeamCategory {
  return v === "avatars" || v === "editors" || v === "smm";
}

/**
 * Reads the route scope from the pathname rather than useParams(), because
 * the sidebar and top bar render in the layout route — above the routes
 * that actually declare :clientId and :memberId — so useParams() there
 * cannot see them.
 */
export function useRouteScope(): RouteScope {
  const { pathname } = useLocation();
  const parts = pathname.split("/").filter(Boolean);

  if (parts[0] === "clients" && parts[1]) return { clientId: parts[1] };
  if (parts[0] === "team" && parts[1] === "agents" && parts[2]) return { agentId: parts[2] };
  if (parts[0] === "team" && isCategory(parts[1]) && parts[2]) {
    return { category: parts[1], memberId: parts[2] };
  }
  return {};
}

const RECENT_KEY = "aa-console:recent-clients";
const RECENT_LIMIT = 12;

/** Most-recently-viewed client ids, newest first. */
export function getRecentClientIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function recordClientVisit(id: string) {
  try {
    const next = [id, ...getRecentClientIds().filter((x) => x !== id)].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode — the dashboard falls back to newest clients */
  }
}

export type RouteClient = { id: string; name: string; sector: string | null };
export type RouteMember = { id: string; name: string; engagement: string };
export type RouteAgent = { agent_key: string; name: string; paused: boolean };

export type RouteEntities = {
  scope: RouteScope;
  client: RouteClient | null;
  member: RouteMember | null;
  agent: RouteAgent | null;
  loading: boolean;
};

/** Resolves whatever the current route points at, from the database. */
export function useRouteEntities(): RouteEntities {
  const scope = useRouteScope();
  const { clientId, memberId, agentId } = scope;

  const [client, setClient] = useState<RouteClient | null>(null);
  const [member, setMember] = useState<RouteMember | null>(null);
  const [agent, setAgent] = useState<RouteAgent | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!clientId) {
      setClient(null);
      return;
    }
    setLoading(true);
    void supabase
      .from("clients")
      .select("id, name, sector")
      .eq("id", clientId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          setClient((data as RouteClient) ?? null);
          if (data) recordClientVisit(clientId);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;
    if (!memberId) {
      setMember(null);
      return;
    }
    setLoading(true);
    void supabase
      .from("team_members")
      .select("id, name, engagement")
      .eq("id", memberId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          setMember((data as RouteMember) ?? null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [memberId]);

  useEffect(() => {
    let cancelled = false;
    if (!agentId) {
      setAgent(null);
      return;
    }
    setLoading(true);
    void supabase
      .from("agents")
      .select("agent_key, name, paused")
      .eq("agent_key", agentId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          setAgent((data as RouteAgent) ?? null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return { scope, client, member, agent, loading };
}
