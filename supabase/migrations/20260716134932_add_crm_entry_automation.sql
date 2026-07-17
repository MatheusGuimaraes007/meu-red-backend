alter table public.crm_funnels
  add column if not exists entry_stage_id uuid;

alter table public.crm_funnels
  drop constraint if exists crm_funnels_entry_stage_id_fkey;

alter table public.crm_funnels
  add constraint crm_funnels_entry_stage_id_fkey
  foreign key (entry_stage_id)
  references public.crm_stages(id)
  on delete set null;

create index if not exists crm_funnels_entry_stage_idx
  on public.crm_funnels (entry_stage_id);

with ranked_defaults as (
  select id,
    row_number() over (
      partition by whatsapp_config_id
      order by updated_at desc, created_at asc, id
    ) as position
  from public.crm_funnels
  where is_default = true
)
update public.crm_funnels as funnel
set is_default = false,
    updated_at = now()
from ranked_defaults
where funnel.id = ranked_defaults.id
  and ranked_defaults.position > 1;

create unique index if not exists crm_funnels_single_default_per_instance_idx
  on public.crm_funnels (whatsapp_config_id)
  where is_default = true;
