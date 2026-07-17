import { normalizeRuntimeDatabaseUrl } from './prisma.service';

describe('normalizeRuntimeDatabaseUrl', () => {
  it('replaces the invalid direct-host pooler URL with Supavisor IPv4', () => {
    const result = new URL(
      normalizeRuntimeDatabaseUrl(
        'postgresql://postgres:secret@db.projectref.supabase.co:6543/postgres?pgbouncer=true',
        'aws-1-us-east-1.pooler.supabase.com',
        'https://projectref.supabase.co',
      ),
    );

    expect(result.hostname).toBe('aws-1-us-east-1.pooler.supabase.com');
    expect(result.port).toBe('6543');
    expect(decodeURIComponent(result.username)).toBe('postgres.projectref');
    expect(result.searchParams.get('connection_limit')).toBe('5');
  });

  it('keeps an already valid pooler URL unchanged', () => {
    const valid =
      'postgresql://postgres.projectref:secret@aws-1-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5';
    expect(
      normalizeRuntimeDatabaseUrl(valid, 'aws-1-us-east-1.pooler.supabase.com'),
    ).toBe(valid);
  });

  it('adds the tenant to a pooler URL that still uses the direct username', () => {
    const result = new URL(
      normalizeRuntimeDatabaseUrl(
        'postgresql://postgres:secret@aws-1-us-east-1.pooler.supabase.com:6543/postgres',
        'aws-1-us-east-1.pooler.supabase.com',
        'https://projectref.supabase.co',
      ),
    );

    expect(decodeURIComponent(result.username)).toBe('postgres.projectref');
    expect(result.searchParams.get('pgbouncer')).toBe('true');
    expect(result.searchParams.get('connection_limit')).toBe('5');
  });

  it('converts the IPv6-only direct URL to the IPv4 transaction pooler', () => {
    const result = new URL(
      normalizeRuntimeDatabaseUrl(
        'postgresql://postgres:secret@db.projectref.supabase.co:5432/postgres',
        'aws-1-us-east-1.pooler.supabase.com',
        'https://projectref.supabase.co',
      ),
    );

    expect(result.hostname).toBe('aws-1-us-east-1.pooler.supabase.com');
    expect(result.port).toBe('6543');
    expect(decodeURIComponent(result.username)).toBe('postgres.projectref');
  });

  it('requires SUPABASE_URL when a pooler URL has no tenant suffix', () => {
    expect(() =>
      normalizeRuntimeDatabaseUrl(
        'postgresql://postgres:secret@aws-1-us-east-1.pooler.supabase.com:6543/postgres',
        'aws-1-us-east-1.pooler.supabase.com',
      ),
    ).toThrow('SUPABASE_URL is required to determine the pooler tenant');
  });
});
