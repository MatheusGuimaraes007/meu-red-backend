-- Private bucket. All access is mediated by the NestJS backend using the
-- service-role key; the browser receives short-lived signed URLs only.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'chat-media',
  'chat-media',
  false,
  52428800,
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/webm', 'video/quicktime',
    'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm',
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain', 'text/csv', 'application/zip'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.messages
  add column if not exists media_storage_bucket text,
  add column if not exists media_storage_path text,
  add column if not exists media_mime_type text,
  add column if not exists media_extension text,
  add column if not exists media_original_name text,
  add column if not exists media_size bigint,
  add column if not exists media_duration_seconds integer,
  add column if not exists media_status text,
  add column if not exists media_error text;

create index if not exists idx_messages_media_storage_path
  on public.messages (media_storage_bucket, media_storage_path)
  where media_storage_path is not null;

create index if not exists idx_messages_media_status
  on public.messages (media_status, created_at desc)
  where media_status is not null;
