create table if not exists public.crm_user_instance_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.crm_users(id) on delete cascade,
  whatsapp_config_id uuid not null references public.whatsapp_config(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, whatsapp_config_id)
);

create index if not exists crm_user_instance_permissions_config_idx
  on public.crm_user_instance_permissions (whatsapp_config_id);

create table if not exists public.crm_user_contact_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.crm_users(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, contact_id)
);

create index if not exists crm_user_contact_permissions_contact_idx
  on public.crm_user_contact_permissions (contact_id);

create table if not exists public.crm_user_funnel_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.crm_users(id) on delete cascade,
  funnel_id uuid not null references public.crm_funnels(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, funnel_id)
);

create index if not exists crm_user_funnel_permissions_funnel_idx
  on public.crm_user_funnel_permissions (funnel_id);

create table if not exists public.crm_user_dashboard_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.crm_users(id) on delete cascade,
  dashboard_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, dashboard_key)
);
