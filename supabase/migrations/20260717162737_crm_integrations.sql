create table if not exists public.crm_integrations (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique,
  name text not null,
  type text not null default 'lead_receiver',
  token_hash text not null,
  token_prefix text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.crm_integration_automations (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references public.crm_integrations(id) on delete cascade,
  event_type text not null default 'lead.received',
  whatsapp_config_id uuid not null references public.whatsapp_config(id) on delete cascade,
  funnel_id uuid not null references public.crm_funnels(id) on delete cascade,
  stage_id uuid not null references public.crm_stages(id) on delete cascade,
  existing_contact_strategy text not null default 'keep_current_stage'
    check (existing_contact_strategy in ('keep_current_stage', 'move_to_configured_stage', 'ignore')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (integration_id, event_type)
);

create table if not exists public.crm_integration_deliveries (
  id bigint generated always as identity primary key,
  integration_id uuid not null references public.crm_integrations(id) on delete cascade,
  external_id text,
  request_id text not null unique,
  status text not null,
  contact_id uuid references public.contacts(id) on delete set null,
  error text,
  received_at timestamptz not null default now(),
  unique (integration_id, external_id)
);

create index if not exists crm_integration_automations_instance_idx on public.crm_integration_automations (whatsapp_config_id);
create index if not exists crm_integration_automations_funnel_idx on public.crm_integration_automations (funnel_id);
create index if not exists crm_integration_automations_stage_idx on public.crm_integration_automations (stage_id);
create index if not exists crm_integration_deliveries_recent_idx on public.crm_integration_deliveries (integration_id, received_at desc);

alter table public.crm_integrations enable row level security;
alter table public.crm_integration_automations enable row level security;
alter table public.crm_integration_deliveries enable row level security;

revoke all on table public.crm_integrations from anon, authenticated;
revoke all on table public.crm_integration_automations from anon, authenticated;
revoke all on table public.crm_integration_deliveries from anon, authenticated;
revoke all on sequence public.crm_integration_deliveries_id_seq from anon, authenticated;
