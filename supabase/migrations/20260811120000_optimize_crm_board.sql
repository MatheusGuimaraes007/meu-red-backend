-- Supports authorized board filtering, stage totals and newest-first card pagination.
-- Non-destructive: rollback with DROP INDEX CONCURRENTLY IF EXISTS public.contacts_board_idx;
create index concurrently if not exists contacts_board_idx
  on public.contacts (whatsapp_config_id, crm_funnel_id, crm_stage_id, last_interaction desc nulls last);
