import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Bot, ChevronDown, MessageSquare, PenLine, Plus, SendHorizontal, Trash2, Wrench } from "lucide-react";
import { EmptyState } from "../EmptyState";
import { ConfirmModal } from "../forms/FormModal";
import { RichText } from "./RichText";
import { useAuth } from "../../context/auth";
import { supabase } from "../../lib/supabase";
import { masterAIConfigured, sendMasterMessage } from "../../lib/masterAI";
import type { MasterScope, ToolCall } from "../../lib/masterAI";
import { cn } from "../../lib/cn";

type Thread = { id: string; title: string | null; updated_at: string };

type Turn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: ToolCall[];
  costUsd: number | null;
};

const SUGGESTIONS: Record<"client" | "company", string[]> = {
  client: [
    "What's the state of this client — what has run, what hasn't?",
    "Run the ICP agent and tell me when it lands",
    "Which ideas are waiting on approval?",
  ],
  company: [
    "Which clients have no intelligence records yet?",
    "Show me every failed agent job this week and why it failed",
    "Is the runtime healthy?",
  ],
};

/**
 * The Master AI chat surface. Admin-only, in both placements.
 *
 * The scope prop decides the blast radius, but it is only a hint: the
 * server binds scope to the conversation row on creation and re-reads it
 * every turn, so a tampered request cannot widen it.
 */
export function MasterAIChat({ scope, title }: { scope: MasterScope; title?: string }) {
  const { profile } = useAuth();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Thread | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);

  const clientId = scope.kind === "client" ? scope.clientId : null;

  const loadMessages = useCallback(async (id: string) => {
    const { data: rows } = await supabase
      .from("master_ai_messages")
      .select("id, role, content, tool_calls, cost_usd")
      .eq("conversation_id", id)
      .order("created_at");
    setTurns(
      (rows ?? []).map((r) => ({
        id: r.id as string,
        role: r.role as "user" | "assistant",
        content: r.content as string,
        toolCalls: (r.tool_calls ?? []) as unknown as ToolCall[],
        costUsd: r.cost_usd as number | null,
      })),
    );
  }, []);

  /**
   * Threads are per scope: a client's threads never appear on the company
   * dashboard and vice versa, so switching cannot silently move you into a
   * conversation with a different blast radius.
   */
  const loadThreads = useCallback(async () => {
    let query = supabase
      .from("master_ai_conversations")
      .select("id, title, updated_at")
      .eq("scope", scope.kind)
      .order("updated_at", { ascending: false })
      .limit(25);
    query = clientId ? query.eq("client_id", clientId) : query.is("client_id", null);
    const { data } = await query;
    const list = (data ?? []) as Thread[];
    setThreads(list);
    return list;
  }, [scope.kind, clientId]);

  const loadRecent = useCallback(async () => {
    const list = await loadThreads();
    const id = list[0]?.id ?? null;
    setConversationId(id);
    if (id) await loadMessages(id);
    else setTurns([]);
  }, [loadThreads, loadMessages]);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length, busy]);

  if (profile?.role !== "admin") return null;

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setError(null);
    setDraft("");
    setBusy(true);
    setTurns((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", content: message, toolCalls: [], costUsd: null },
    ]);

    try {
      const reply = await sendMasterMessage({ scope, conversationId, message });
      setConversationId(reply.conversationId);
      void loadThreads();
      setTurns((prev) => [
        ...prev,
        {
          id: `reply-${Date.now()}`,
          role: "assistant",
          content: reply.reply,
          toolCalls: reply.toolCalls,
          costUsd: reply.costUsd,
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send(draft);
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const heading =
    title ?? (scope.kind === "client" ? "Master AI — this client" : "Master AI — whole business");
  const scopeNote =
    scope.kind === "client"
      ? "Scoped to this client. It cannot see or change another client's data."
      : "Full access to every client, the team and finance.";

  return (
    <section className="flex flex-col rounded-lg border border-border bg-card">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <Bot className="h-4 w-4 text-brand-strong" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-card-foreground">{heading}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{scopeNote}</p>
          </div>
        </div>
        <div className="relative flex shrink-0 items-center gap-1">
          {threads.length > 0 && (
            <button
              type="button"
              onClick={() => setThreadsOpen((v) => !v)}
              aria-expanded={threadsOpen}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              {threads.length} thread{threads.length === 1 ? "" : "s"}
              <ChevronDown
                className={cn("h-3 w-3 transition-transform", threadsOpen && "rotate-180")}
                aria-hidden="true"
              />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setConversationId(null);
              setTurns([]);
              setError(null);
              setThreadsOpen(false);
            }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            New
          </button>

          {threadsOpen && (
            <>
              <button
                type="button"
                aria-label="Close thread list"
                className="fixed inset-0 z-10 cursor-default"
                onClick={() => setThreadsOpen(false)}
              />
              <ul className="absolute right-0 top-full z-20 mt-1 max-h-72 w-72 overflow-y-auto rounded-lg border border-border bg-card py-1 shadow-lg">
                {threads.map((thread) => (
                  <li
                    key={thread.id}
                    className={cn(
                      "group flex items-stretch gap-1 pr-1 hover:bg-accent",
                      thread.id === conversationId && "bg-accent",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setConversationId(thread.id);
                        setError(null);
                        setThreadsOpen(false);
                        void loadMessages(thread.id);
                      }}
                      className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="line-clamp-2 text-xs text-foreground">
                        {thread.title?.trim() || "Untitled thread"}
                      </span>
                      <span className="text-[0.7rem] text-muted-foreground">
                        {new Date(thread.updated_at).toLocaleString()}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete thread: ${thread.title?.trim() || "Untitled thread"}`}
                      onClick={() => {
                        setPendingDelete(thread);
                        setThreadsOpen(false);
                      }}
                      className="my-1 shrink-0 self-center rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </header>

      <div className="max-h-[26rem] min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {turns.length === 0 ? (
          <div className="space-y-3">
            <EmptyState label="Ask it anything about the data, or tell it to run something." minHeight={80} />
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS[scope.kind].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn) => (
            <div key={turn.id} className={cn(turn.role === "user" && "flex justify-end")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm",
                  turn.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {turn.role === "assistant" ? (
                  <RichText text={turn.content} />
                ) : (
                  <p className="whitespace-pre-wrap">{turn.content}</p>
                )}

                {turn.toolCalls.length > 0 && (
                  <div className="mt-2 border-t border-border/60 pt-2">
                    <button
                      type="button"
                      onClick={() => toggle(turn.id)}
                      className="flex items-center gap-1.5 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Wrench className="h-3 w-3" aria-hidden="true" />
                      {turn.toolCalls.length} action{turn.toolCalls.length === 1 ? "" : "s"}
                      {turn.toolCalls.some((t) => t.mutating) && (
                        <span className="inline-flex items-center gap-1 text-brand-strong">
                          <PenLine className="h-3 w-3" aria-hidden="true" />
                          wrote
                        </span>
                      )}
                      <ChevronDown
                        className={cn("h-3 w-3 transition-transform", expanded.has(turn.id) && "rotate-180")}
                        aria-hidden="true"
                      />
                    </button>
                    {expanded.has(turn.id) && (
                      <ul className="mt-1.5 space-y-1">
                        {turn.toolCalls.map((call, i) => (
                          <li key={i} className="flex gap-1.5 text-xs text-muted-foreground">
                            <span className={cn("font-medium", call.mutating && "text-brand-strong")}>
                              {call.tool}
                            </span>
                            <span>— {call.summary}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))
        )}

        {busy && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
            Working…
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div ref={endRef} />
      </div>

      <ConfirmModal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete this thread?"
        body={
          pendingDelete
            ? `"${pendingDelete.title?.trim() || "Untitled thread"}" and every message in it will be removed. This cannot be undone. Nothing the Master AI did — jobs it queued, rows it wrote — is affected.`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!pendingDelete) return;
          const { error: deleteError } = await supabase
            .from("master_ai_conversations")
            .delete()
            .eq("id", pendingDelete.id);
          if (deleteError) throw new Error(deleteError.message);

          const remaining = await loadThreads();
          // Deleting the thread you are reading leaves the view showing a
          // conversation that no longer exists, so fall back to the next
          // most recent rather than stranding it.
          if (pendingDelete.id === conversationId) {
            const next = remaining[0]?.id ?? null;
            setConversationId(next);
            if (next) await loadMessages(next);
            else setTurns([]);
          }
          setPendingDelete(null);
        }}
      />

      <form onSubmit={onSubmit} className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy || !masterAIConfigured()}
          placeholder={
            masterAIConfigured() ? "Ask, or tell it to run something…" : "Set VITE_AGENT_RUNTIME_URL to enable"
          }
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim() || !masterAIConfigured()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <SendHorizontal className="h-4 w-4" aria-hidden="true" />
          Send
        </button>
      </form>
    </section>
  );
}
