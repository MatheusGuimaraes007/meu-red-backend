-- Additive migration only: preserves every existing CRM record.

alter table public.whatsapp_config
  add column if not exists instance_name text,
  add column if not exists plan_type text,
  add column if not exists payment_status text,
  add column if not exists expires_at timestamptz,
  add column if not exists auto_renew boolean,
  add column if not exists is_trial boolean not null default false,
  add column if not exists automatic_reading boolean not null default false,
  add column if not exists reject_calls boolean not null default true,
  add column if not exists call_message text,
  add column if not exists webhook_connected_url text,
  add column if not exists webhook_delivery_url text,
  add column if not exists webhook_disconnected_url text,
  add column if not exists webhook_status_url text,
  add column if not exists webhook_presence_url text,
  add column if not exists webhook_received_url text,
  add column if not exists last_seen_at timestamptz,
  add column if not exists disconnected_at timestamptz;

create index if not exists idx_whatsapp_config_status
  on public.whatsapp_config (status);
create index if not exists idx_whatsapp_config_provider_instance
  on public.whatsapp_config (provider_instance_id);

alter table public.messages
  add column if not exists status text not null default 'sent',
  add column if not exists error_message text,
  add column if not exists client_message_id text,
  add column if not exists original_content text,
  add column if not exists edited_content text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists deleted_on_whatsapp boolean not null default false,
  add column if not exists deleted_at timestamptz,
  add column if not exists read_at timestamptz;

create unique index if not exists messages_instance_client_message_idx
  on public.messages (whatsapp_config_id, client_message_id)
  where client_message_id is not null;
create index if not exists idx_messages_status_created_at
  on public.messages (status, created_at desc);
create index if not exists idx_messages_external_message_id
  on public.messages (external_message_id)
  where external_message_id is not null;

create table if not exists public.message_edits (
  id uuid primary key default gen_random_uuid(),
  message_id bigint not null references public.messages(id) on delete cascade,
  previous_content text not null,
  new_content text not null,
  edited_by uuid references public.crm_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_message_edits_message_created
  on public.message_edits (message_id, created_at desc);
alter table public.message_edits enable row level security;

create table if not exists public.crm_refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.crm_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  replaced_by_token_id uuid references public.crm_refresh_tokens(id) on delete set null,
  user_agent text,
  ip_address inet,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_crm_refresh_tokens_user_active
  on public.crm_refresh_tokens (user_id, expires_at desc)
  where revoked_at is null;
alter table public.crm_refresh_tokens enable row level security;

create index if not exists webhook_events_source_external_idempotency_idx
  on public.webhook_events (source, external_event_id)
  where external_event_id is not null;
