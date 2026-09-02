-- Run once in the Supabase SQL editor before deploying.
create table if not exists public.sof_documents (
  id uuid primary key default gen_random_uuid(),
  file_path text not null unique,
  vessel text,
  voyage text,
  port text,
  charterer text,
  created_at timestamptz not null default now()
);

alter table public.sof_documents enable row level security;
create policy "No anonymous access" on public.sof_documents for all using (false);

insert into storage.buckets (id, name, public) values ('sof-documents', 'sof-documents', false)
on conflict (id) do nothing;
