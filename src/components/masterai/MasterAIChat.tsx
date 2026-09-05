import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Bot, ChevronDown, PenLine, SendHorizontal, Wrench } from "lucide-react";
import { EmptyState } from "../EmptyState";
import { RichText } from "./RichText";
import { useAuth } from "../../context/auth";
import { supabase } from "../../lib/supabase";
import { masterAIConfigured, sendMasterMessage } from "../../lib/masterAI";
import type { MasterScope, ToolCall } from "../../lib/masterAI";
import { cn } from "../../lib/cn";

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
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);

  const clientId = scope.kind === "client" ? scope.clientId : null;

  // Reload the most recent thread for this scope so the chat survives a
  // reload rather than starting blank every time.
  const loadRecent = useCallback(async () => {
    let query = supabase
      .from("master_ai_conversations")
      .select("id")
      .eq("scope", scope.kind)
      .order("updated_at", { ascending: false })
      .limit(1);
    query = clientId ? query.eq("client_id", clientId) : query.is("client_id", null);

    const { data: convos } = await query;
    const id = convos?.[0]?.id ?? null;
    if (!id) {
      setConversationId(null);
      setTurns([]);
      return;
    }
    const { data: rows } = await supabase
      .from("master_ai_messages")
      .select("id, role, content, tool_calls, cost_usd")
      .eq("conversation_id", id)
      .order("created_at");
    setConversationId(id);
    setTurns(
      (rows ?? []).map((r) => ({
        id: r.id as string,
        role: r.role as "user" | "assistant",
        content: r.content as string,
        toolCalls: (r.tool_calls ?? []) as unknown as ToolCall[],
        costUsd: r.cost_usd as number | null,
      })),
    );
  }, [scope.kind, clientId]);

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
        {turns.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setConversationId(null);
              setTurns([]);
              setError(null);
            }}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            New thread
          </button>
        )}
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
