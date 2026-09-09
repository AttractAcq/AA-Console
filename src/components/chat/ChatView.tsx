import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Plus, SendHorizontal, UserPlus } from "lucide-react";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { FormModal } from "../forms/FormModal";
import type { FieldDef, Option } from "../forms/fields";
import { useAuth } from "../../context/auth";
import { supabase } from "../../lib/supabase";
import { stickToBottom } from "../../lib/stickToBottom";
import { cn } from "../../lib/cn";

type Channel = { id: string; name: string };
type Message = {
  id: string;
  channel_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
};

function initials(name: string | null): string {
  const source = name?.trim() || "?";
  return source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The whole chat surface, shared by all five consoles. `canManage` adds
 * channel creation and member management, which only the admin console
 * passes. Everyone else sees exactly the channels they were added to,
 * enforced by RLS rather than by this filter.
 */
export function ChatView({ canManage = false }: { canManage?: boolean }) {
  const { profile } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  // Names only. Chat used to read whole profile rows through an RLS policy
  // that also handed over staff email addresses, and let two clients in one
  // channel read each other. chat_participants() returns a name and nothing
  // else.
  const [authors, setAuthors] = useState<Map<string, string>>(new Map());
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [addChannelOpen, setAddChannelOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [peopleOptions, setPeopleOptions] = useState<Option[]>([]);
  const [memberCount, setMemberCount] = useState(0);

  const listRef = useRef<HTMLDivElement>(null);

  const loadChannels = useCallback(async () => {
    const { data } = await supabase.from("team_channels").select("id, name").order("name");
    const rows = (data ?? []) as Channel[];
    setChannels(rows);
    setActiveId((current) => current ?? rows[0]?.id ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  const loadMessages = useCallback(async (channelId: string) => {
    const { data } = await supabase
      .from("team_messages")
      .select("id, channel_id, author_id, body, created_at")
      .eq("channel_id", channelId)
      .order("created_at")
      .limit(200);
    const rows = (data ?? []) as Message[];
    setMessages(rows);

    const { data: people } = await supabase.rpc("chat_participants");
    setAuthors(
      new Map(((people ?? []) as Array<{ id: string; display_name: string | null }>).map((p) => [
        p.id,
        p.display_name ?? "",
      ])),
    );
  }, []);

  // Load the thread, then subscribe. Realtime gives the live half; the
  // fetch gives the history.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void loadMessages(activeId);
    void supabase
      .from("channel_members")
      .select("user_id", { count: "exact", head: true })
      .eq("channel_id", activeId)
      .then(({ count }) => {
        if (!cancelled) setMemberCount(count ?? 0);
      });

    const channel = supabase
      .channel(`chat:${activeId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "team_messages",
          filter: `channel_id=eq.${activeId}`,
        },
        (payload) => {
          const next = payload.new as Message;
          setMessages((prev) => (prev.some((m) => m.id === next.id) ? prev : [...prev, next]));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [activeId, loadMessages]);

  useEffect(() => {
    stickToBottom(listRef.current);
  }, [messages]);

  // People not already in the channel.
  useEffect(() => {
    if (!addMemberOpen || !activeId) return;
    let cancelled = false;
    void (async () => {
      const [{ data: people }, { data: existing }] = await Promise.all([
        supabase.from("profiles").select("id, full_name, email, role").order("full_name"),
        supabase.from("channel_members").select("user_id").eq("channel_id", activeId),
      ]);
      if (cancelled) return;
      const taken = new Set((existing ?? []).map((m) => m.user_id));
      setPeopleOptions(
        (people ?? [])
          .filter((p) => !taken.has(p.id))
          .map((p) => ({
            value: p.id,
            label: `${p.full_name ?? p.email ?? p.id} · ${p.role}`,
          })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [addMemberOpen, activeId]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !activeId || !profile) return;

    setSending(true);
    setError(null);
    // Clear straight away — the row comes back over Realtime.
    setDraft("");
    const { error: insertError } = await supabase
      .from("team_messages")
      .insert({ channel_id: activeId, author_id: profile.id, body });
    setSending(false);
    if (insertError) {
      setError(insertError.message);
      setDraft(body);
    }
  }

  const activeChannel = channels.find((c) => c.id === activeId);
  const memberFields: FieldDef[] = [
    { name: "user_id", label: "Person", kind: "select", required: true, options: peopleOptions },
  ];

  if (loading) return <p className="text-sm text-muted-foreground">Loading chat…</p>;

  return (
    <div className="grid gap-4 md:grid-cols-[220px_1fr]">
      <div className="space-y-2">
        {canManage && (
          <Button icon={Plus} onClick={() => setAddChannelOpen(true)} className="w-full">
            Add Channel
          </Button>
        )}
        <div className="space-y-1 rounded-lg border border-border bg-card p-2">
          {channels.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              {canManage ? "No channels yet" : "You have not been added to a channel yet"}
            </p>
          ) : (
            channels.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setActiveId(c.id)}
                className={cn(
                  "w-full rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  activeId === c.id
                    ? "bg-secondary font-medium text-secondary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                # {c.name}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex min-h-[460px] flex-col rounded-lg border border-border bg-card">
        {!activeChannel ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState
              label={canManage ? "Select a channel" : "No channels yet"}
              minHeight={200}
            />
          </div>
        ) : (
          <>
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-card-foreground">
                  # {activeChannel.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {memberCount} member{memberCount === 1 ? "" : "s"}
                </p>
              </div>
              {canManage && (
                <Button icon={UserPlus} onClick={() => setAddMemberOpen(true)}>
                  Add Members
                </Button>
              )}
            </div>

            <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-4">
              {messages.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No messages yet — say something.
                </p>
              ) : (
                messages.map((m) => {
                  const author = m.author_id ? authors.get(m.author_id) : undefined;
                  const mine = m.author_id === profile?.id;
                  return (
                    <div key={m.id} className="flex gap-2.5">
                      <div
                        className={cn(
                          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                          mine
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary text-secondary-foreground",
                        )}
                      >
                        {initials(author ?? null)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {mine ? "You" : (author || "Unknown")}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {timeOf(m.created_at)}
                          </span>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                          {m.body}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <form
              onSubmit={send}
              className="flex shrink-0 items-center gap-2 border-t border-border p-3"
            >
              <input
                aria-label="Message"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={`Message #${activeChannel.name}`}
                className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                aria-label="Send message"
                className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <SendHorizontal className="h-4 w-4" aria-hidden="true" />
              </button>
            </form>

            {error && (
              <p role="alert" className="border-t border-border px-4 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
          </>
        )}
      </div>

      {canManage && (
        <>
          <FormModal
            open={addChannelOpen}
            onClose={() => setAddChannelOpen(false)}
            title="Add Channel"
            draftKey="add-channel"
            fields={[
              { name: "name", label: "Channel name", kind: "text", required: true, placeholder: "general" },
            ]}
            submitLabel="Create channel"
            onSubmit={async (v) => {
              const name = (v.name as string).trim().toLowerCase();
              const { data, error: insertError } = await supabase
                .from("team_channels")
                .insert({ name })
                .select("id")
                .single();
              if (insertError) throw insertError;
              // The creator joins their own channel, otherwise it is
              // invisible to them the moment RLS applies.
              if (profile) {
                await supabase
                  .from("channel_members")
                  .insert({ channel_id: data.id, user_id: profile.id });
              }
              setActiveId(data.id);
            }}
            onSaved={loadChannels}
          />

          <FormModal
            open={addMemberOpen}
            onClose={() => setAddMemberOpen(false)}
            title={`Add member to #${activeChannel?.name ?? ""}`}
            intro="Anyone added here sees this channel on their own Chat page."
            fields={memberFields}
            submitLabel="Add member"
            onSubmit={async (v) => {
              if (!activeId) throw new Error("No channel selected.");
              const { error: insertError } = await supabase.from("channel_members").insert({
                channel_id: activeId,
                user_id: v.user_id as string,
                added_by: profile?.id ?? null,
              });
              if (insertError) throw insertError;
            }}
            onSaved={() => {
              if (activeId) {
                void supabase
                  .from("channel_members")
                  .select("user_id", { count: "exact", head: true })
                  .eq("channel_id", activeId)
                  .then(({ count }) => setMemberCount(count ?? 0));
              }
            }}
          />
        </>
      )}
    </div>
  );
}
