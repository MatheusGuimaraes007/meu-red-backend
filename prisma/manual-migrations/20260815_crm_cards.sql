-- =====================================================================
-- FASE 1 (CARDS COMERCIAL/SUPORTE) - migration preparada em 15/08/2026.
--
-- NAO APLICAR AUTOMATICAMENTE. Este arquivo existe para revisao humana e
-- aplicacao manual (Supabase SQL editor ou equivalente) somente apos
-- aprovacao explicita.
--
-- Corresponde as alteracoes em prisma/schema.prisma. Depois de aplicar,
-- rode `npm run prisma:pull` seguido de `git diff prisma/schema.prisma`
-- para confirmar que o schema introspectado bate com o que foi commitado
-- aqui - e so entao `npm run prisma:generate`.
--
-- E seguro rodar em um banco vazio (todas as operacoes sao aditivas: novos
-- tipos, novas tabelas, novas colunas nullable). Nao altera nem apaga
-- nenhuma linha existente em contacts/messages/crm_funnels/crm_users.
--
-- Rollback: ver bloco comentado ao final do arquivo.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Enums novos
-- ---------------------------------------------------------------------
CREATE TYPE public.crm_card_kind AS ENUM ('sales', 'support');
CREATE TYPE public.crm_card_status AS ENUM ('active', 'closed');
CREATE TYPE public.crm_card_source AS ENUM (
  'manual', 'first_message', 'csv_import', 'automation', 'claim', 'transfer', 'migration'
);
CREATE TYPE public.crm_card_event_type AS ENUM (
  'created', 'claimed', 'assigned', 'transferred', 'stage_changed',
  'funnel_changed', 'closed', 'reopened', 'automation'
);
CREATE TYPE public.crm_department AS ENUM ('sales', 'support', 'both', 'management');
CREATE TYPE public.crm_message_context AS ENUM ('sales', 'support', 'automation', 'system');

-- ---------------------------------------------------------------------
-- 2. Colunas novas em tabelas existentes (todas nullable - nao alteram
--    nenhuma linha existente, nenhum default forcado).
-- ---------------------------------------------------------------------

-- crm_funnels: tipo (sales/support) e dono. kind fica NULL = "nao
-- classificado ainda" ate a Fase 7 (dry-run) classificar manualmente.
-- Um usuario pode ser dono de varios funis sales (confirmado com o cliente).
ALTER TABLE public.crm_funnels
  ADD COLUMN kind public.crm_card_kind NULL,
  ADD COLUMN owner_user_id UUID NULL REFERENCES public.crm_users(id) ON DELETE SET NULL;

CREATE INDEX crm_funnels_kind_idx ON public.crm_funnels (whatsapp_config_id, kind);
CREATE INDEX crm_funnels_owner_idx ON public.crm_funnels (owner_user_id);

-- crm_users: area/departamento. NULL para todos os usuarios existentes -
-- classificacao manual, nao automatica (ver secao 12 do documento).
ALTER TABLE public.crm_users
  ADD COLUMN department public.crm_department NULL;

-- messages: auditoria de quem enviou e em qual contexto (sales/support/
-- automation/system). NULL para mensagens recebidas do cliente e para
-- todo o historico anterior a esta fase.
ALTER TABLE public.messages
  ADD COLUMN sent_by_user_id UUID NULL REFERENCES public.crm_users(id) ON DELETE SET NULL,
  ADD COLUMN sent_by_context public.crm_message_context NULL,
  ADD COLUMN crm_card_id UUID NULL; -- FK adicionada na secao 6, depois de crm_cards existir

CREATE INDEX idx_messages_crm_card_id ON public.messages (crm_card_id);

-- ---------------------------------------------------------------------
-- 3. crm_cards
-- ---------------------------------------------------------------------
CREATE TABLE public.crm_cards (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  kind              public.crm_card_kind NOT NULL,
  funnel_id         UUID NOT NULL REFERENCES public.crm_funnels(id) ON DELETE RESTRICT,
  stage_id          UUID NOT NULL REFERENCES public.crm_stages(id) ON DELETE RESTRICT,
  assigned_user_id  UUID NULL REFERENCES public.crm_users(id) ON DELETE SET NULL,
  status            public.crm_card_status NOT NULL DEFAULT 'active',
  source            public.crm_card_source NOT NULL,
  stage_entered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_at       TIMESTAMPTZ NULL,
  closed_at         TIMESTAMPTZ NULL,
  metadata          JSONB NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX crm_cards_contact_kind_status_idx ON public.crm_cards (contact_id, kind, status);
CREATE INDEX crm_cards_funnel_stage_idx ON public.crm_cards (funnel_id, stage_id);
CREATE INDEX crm_cards_assigned_user_idx ON public.crm_cards (assigned_user_id, status);
CREATE INDEX crm_cards_stage_entered_idx ON public.crm_cards (stage_id, stage_entered_at);

-- Regra central do documento: no maximo 1 card "sales" ativo e 1 "support"
-- ativo por contato. Indice parcial - nao existe sintaxe equivalente na
-- Prisma schema DSL, por isso fica só aqui no SQL manual.
CREATE UNIQUE INDEX crm_cards_unique_active_sales
  ON public.crm_cards (contact_id)
  WHERE kind = 'sales' AND status = 'active';

CREATE UNIQUE INDEX crm_cards_unique_active_support
  ON public.crm_cards (contact_id)
  WHERE kind = 'support' AND status = 'active';

-- Agora que crm_cards existe, liga o FK que ficou pendente em messages.
ALTER TABLE public.messages
  ADD CONSTRAINT messages_crm_card_id_fkey
  FOREIGN KEY (crm_card_id) REFERENCES public.crm_cards(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- 4. crm_card_movements (auditoria)
-- ---------------------------------------------------------------------
CREATE TABLE public.crm_card_movements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id             UUID NOT NULL REFERENCES public.crm_cards(id) ON DELETE CASCADE,
  contact_id          UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  kind                public.crm_card_kind NOT NULL,
  event_type          public.crm_card_event_type NOT NULL,
  from_user_id        UUID NULL REFERENCES public.crm_users(id) ON DELETE SET NULL,
  to_user_id          UUID NULL REFERENCES public.crm_users(id) ON DELETE SET NULL,
  from_funnel_id      UUID NULL REFERENCES public.crm_funnels(id) ON DELETE SET NULL,
  to_funnel_id        UUID NULL REFERENCES public.crm_funnels(id) ON DELETE SET NULL,
  from_stage_id       UUID NULL REFERENCES public.crm_stages(id) ON DELETE SET NULL,
  to_stage_id         UUID NULL REFERENCES public.crm_stages(id) ON DELETE SET NULL,
  actor_user_id       UUID NULL REFERENCES public.crm_users(id) ON DELETE SET NULL,
  automation_rule_id  UUID NULL, -- FK adicionada na secao 5
  reason              TEXT NULL,
  metadata            JSONB NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX crm_card_movements_card_idx ON public.crm_card_movements (card_id, created_at DESC);
CREATE INDEX crm_card_movements_contact_idx ON public.crm_card_movements (contact_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 5. crm_automation_rules / crm_automation_executions
-- ---------------------------------------------------------------------
CREATE TABLE public.crm_automation_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_config_id  UUID NOT NULL REFERENCES public.whatsapp_config(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  card_kind           public.crm_card_kind NULL,
  trigger_type        TEXT NOT NULL,
  source_funnel_id    UUID NULL REFERENCES public.crm_funnels(id) ON DELETE SET NULL,
  source_stage_id     UUID NULL REFERENCES public.crm_stages(id) ON DELETE SET NULL,
  delay_seconds       INTEGER NULL,
  trigger_config      JSONB NULL DEFAULT '{}',
  action_config       JSONB NULL DEFAULT '{}',
  priority            INTEGER NOT NULL DEFAULT 0,
  created_by          UUID NULL REFERENCES public.crm_users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX crm_automation_rules_instance_idx ON public.crm_automation_rules (whatsapp_config_id, enabled);
CREATE INDEX crm_automation_rules_trigger_idx ON public.crm_automation_rules (trigger_type);

ALTER TABLE public.crm_card_movements
  ADD CONSTRAINT crm_card_movements_automation_rule_id_fkey
  FOREIGN KEY (automation_rule_id) REFERENCES public.crm_automation_rules(id) ON DELETE SET NULL;

CREATE TABLE public.crm_automation_executions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id       UUID NOT NULL REFERENCES public.crm_automation_rules(id) ON DELETE CASCADE,
  card_id       UUID NULL REFERENCES public.crm_cards(id) ON DELETE SET NULL,
  contact_id    UUID NULL,
  trigger_key   TEXT NOT NULL,
  status        TEXT NOT NULL,
  result        JSONB NULL DEFAULT '{}',
  error         TEXT NULL,
  executed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chave de idempotencia: a mesma regra nunca executa 2x sobre a mesma
-- "permanencia" (trigger_key e responsabilidade do worker, ex.:
-- "{rule_id}:{card_id}:{stage_entered_at_iso}").
CREATE UNIQUE INDEX crm_automation_executions_idempotency_idx
  ON public.crm_automation_executions (rule_id, trigger_key);

CREATE INDEX crm_automation_executions_card_idx ON public.crm_automation_executions (card_id);

COMMIT;

-- =====================================================================
-- ROLLBACK (execute manualmente se precisar reverter; ordem inversa)
-- =====================================================================
-- BEGIN;
-- DROP TABLE IF EXISTS public.crm_automation_executions;
-- ALTER TABLE public.crm_card_movements DROP CONSTRAINT IF EXISTS crm_card_movements_automation_rule_id_fkey;
-- DROP TABLE IF EXISTS public.crm_automation_rules;
-- DROP TABLE IF EXISTS public.crm_card_movements;
-- ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_crm_card_id_fkey;
-- DROP TABLE IF EXISTS public.crm_cards;
-- ALTER TABLE public.messages DROP COLUMN IF EXISTS sent_by_user_id, DROP COLUMN IF EXISTS sent_by_context, DROP COLUMN IF EXISTS crm_card_id;
-- ALTER TABLE public.crm_users DROP COLUMN IF EXISTS department;
-- ALTER TABLE public.crm_funnels DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS owner_user_id;
-- DROP TYPE IF EXISTS public.crm_message_context;
-- DROP TYPE IF EXISTS public.crm_department;
-- DROP TYPE IF EXISTS public.crm_card_event_type;
-- DROP TYPE IF EXISTS public.crm_card_source;
-- DROP TYPE IF EXISTS public.crm_card_status;
-- DROP TYPE IF EXISTS public.crm_card_kind;
-- COMMIT;
