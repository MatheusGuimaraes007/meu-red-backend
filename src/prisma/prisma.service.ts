import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not defined');

    // Render needs the IPv4 Supavisor endpoint. Older configuration examples
    // combined db.<ref>.supabase.co with port 6543, which is not a real
    // endpoint; using DIRECT_URL instead still fails because it is IPv6-only.
    const runtimeUrl = normalizeRuntimeDatabaseUrl(
      databaseUrl,
      process.env.SUPABASE_POOLER_HOST ?? 'aws-1-us-east-1.pooler.supabase.com',
      process.env.SUPABASE_URL,
    );

    super({ datasourceUrl: runtimeUrl });
  }

  async onModuleInit() {
    await this.$connect();
    await this.ensureIntegrationSchema();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  private async ensureIntegrationSchema() {
    const statements = [
      `create table if not exists public.crm_integrations (
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
      )`,
      `create table if not exists public.crm_integration_automations (
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
      )`,
      `create table if not exists public.crm_integration_deliveries (
        id bigint generated always as identity primary key,
        integration_id uuid not null references public.crm_integrations(id) on delete cascade,
        external_id text,
        request_id text not null unique,
        status text not null,
        contact_id uuid references public.contacts(id) on delete set null,
        error text,
        received_at timestamptz not null default now(),
        unique (integration_id, external_id)
      )`,
      `create index if not exists crm_integration_automations_instance_idx on public.crm_integration_automations (whatsapp_config_id)`,
      `create index if not exists crm_integration_automations_funnel_idx on public.crm_integration_automations (funnel_id)`,
      `create index if not exists crm_integration_automations_stage_idx on public.crm_integration_automations (stage_id)`,
      `create index if not exists crm_integration_deliveries_recent_idx on public.crm_integration_deliveries (integration_id, received_at desc)`,
      `alter table public.crm_integrations enable row level security`,
      `alter table public.crm_integration_automations enable row level security`,
      `alter table public.crm_integration_deliveries enable row level security`,
    ];

    for (const statement of statements) {
      await this.$executeRawUnsafe(statement);
    }
  }
}

export function normalizeRuntimeDatabaseUrl(
  connectionString: string,
  poolerHost: string,
  supabaseUrl?: string,
) {
  try {
    const url = new URL(connectionString);
    const directSupabaseHost =
      url.hostname.startsWith('db.') && url.hostname.endsWith('.supabase.co');
    const poolerSupabaseHost = url.hostname.endsWith('.pooler.supabase.com');

    if (!directSupabaseHost && !poolerSupabaseHost) return connectionString;

    const projectRef = directSupabaseHost
      ? url.hostname.split('.')[1]
      : getProjectRefFromSupabaseUrl(supabaseUrl);

    if (directSupabaseHost) {
      url.hostname = poolerHost;
      url.port = '6543';
    }

    // Supavisor requires the tenant suffix. A URL copied from the direct
    // connection and changed only to the pooler host otherwise reaches the
    // server but fails with Prisma P1000 for user `postgres`.
    if (decodeURIComponent(url.username) === 'postgres') {
      if (!projectRef) {
        throw new Error(
          'SUPABASE_URL is required to determine the pooler tenant',
        );
      }
      url.username = `postgres.${projectRef}`;
    }

    url.searchParams.set('pgbouncer', 'true');
    url.searchParams.set('connection_limit', '5');
    return url.toString();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        'SUPABASE_URL is required to determine the pooler tenant'
    ) {
      throw error;
    }
    throw new Error('DATABASE_URL is not a valid PostgreSQL URL');
  }
}

function getProjectRefFromSupabaseUrl(supabaseUrl?: string) {
  if (!supabaseUrl) return undefined;

  try {
    const hostname = new URL(supabaseUrl).hostname;
    if (!hostname.endsWith('.supabase.co')) return undefined;
    return hostname.split('.')[0] || undefined;
  } catch {
    return undefined;
  }
}
