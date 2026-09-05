create type master_ai_scope as enum ('client', 'company');

create table master_ai_conversations (
  id          uuid primary key default gen_random_uuid(),
  scope       master_ai_scope not null,
  client_id   uuid references clients(id) on delete cascade,
  title       text,
  created_by  uuid not null references auth.users(id) on delete cascade,
  pending_confirmation jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint master_ai_scope_binds_client check (
    (scope = 'client'  and client_id is not null) or
    (scope = 'company' and client_id is null)
  )
);

create index master_ai_conversations_scope_idx
  on master_ai_conversations (scope, client_id, updated_at desc);

create table master_ai_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references master_ai_conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null default '',
  tool_calls      jsonb not null default '[]'::jsonb,
  cost_usd        numeric(10,4),
  created_at      timestamptz not null default now()
);

create index master_ai_messages_conversation_idx
  on master_ai_messages (conversation_id, created_at);

alter table master_ai_conversations enable row level security;
alter table master_ai_messages      enable row level security;

create policy master_ai_conversations_admin on master_ai_conversations
  for all to authenticated using (is_admin()) with check (is_admin());

create policy master_ai_messages_admin on master_ai_messages
  for all to authenticated using (is_admin()) with check (is_admin());

comment on table master_ai_conversations is
  'Admin-only Master AI threads. scope fixes the blast radius: client (one client) or company (everything).';
comment on column master_ai_conversations.pending_confirmation is
  'One-shot nonce for a destructive tool call awaiting human confirmation. Never reused.';
comment on column master_ai_messages.tool_calls is
  'Audit trail of tool calls made on this turn, including arguments and outcome.';;
