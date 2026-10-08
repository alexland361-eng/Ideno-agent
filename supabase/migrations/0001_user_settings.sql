-- Ideno user settings (Supabase).
--
-- SECURITY MODEL — read this before changing anything:
--   This table stores per-user provider settings INCLUDING API KEYS.
--   It is deliberately INVISIBLE to browsers: no RLS policies are created
--   for anon/authenticated roles, and all privileges are revoked from them.
--   Only the Ideno backend, using the SERVICE ROLE key (env-only, server
--   side), may read or write it. The web client receives exclusively
--   redacted views (key hints like "nvapi-…1234", URL origins) from the
--   backend's /api/user/settings endpoint.

create table if not exists public.ideno_user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.ideno_user_settings enable row level security;

-- No policies for client roles; revoke everything explicitly.
revoke all on public.ideno_user_settings from anon, authenticated;
