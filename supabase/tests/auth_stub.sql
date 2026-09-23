-- LOCAL TESTS ONLY. Minimal stand-in for what a hosted Supabase project already
-- provides (roles, auth.users, auth.uid()), so migrations and RLS can be tested
-- against a plain Postgres without Docker. Never apply this to Supabase.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- Like hosted Supabase: anon/authenticated get ALL on new public objects by
-- default. Migrations must revoke what they don't want; tests run with this so
-- missing revokes show up as failing RLS tests.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id          uuid primary key default gen_random_uuid(),
  email       text unique,
  created_at  timestamptz not null default now()
);

-- Same semantics as Supabase: the `sub` claim of the current request's JWT.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
    ),
    ''
  )::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;
