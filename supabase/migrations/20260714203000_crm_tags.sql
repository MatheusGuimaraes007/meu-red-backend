create table if not exists public.crm_tags (
  id uuid primary key default gen_random_uuid(),
  whatsapp_config_id uuid references public.whatsapp_config(id) on delete cascade,
  name text not null,
  color text not null default '#e63946',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists crm_tags_instance_name_key
  on public.crm_tags (whatsapp_config_id, name);

create index if not exists crm_tags_instance_idx
  on public.crm_tags (whatsapp_config_id);

create table if not exists public.crm_contact_tags (
  contact_id uuid not null references public.contacts(id) on delete cascade,
  tag_id uuid not null references public.crm_tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (contact_id, tag_id)
);

create index if not exists crm_contact_tags_tag_idx
  on public.crm_contact_tags (tag_id);
