-- Omdømme-tracker: core schema.
-- CONTRACT (phase 0): changing tables, columns or allowed values requires Leon's approval.
--
-- Access model:
--   * The web app talks to Supabase as the `authenticated` role; RLS limits every
--     user to the single profile they are a member of.
--   * The worker connects as `postgres` (via DATABASE_URL), which bypasses RLS.
--   * Rows that need several inserts at once (create profile, accept invite,
--     leave profile) go through SECURITY DEFINER functions, not direct inserts.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (length(trim(name)) > 0),
  website_url         text,
  social_links        text[] not null default '{}',
  created_at          timestamptz not null default now(),
  backfill_status     text not null default 'pending'
                      check (backfill_status in ('pending', 'running', 'done', 'failed')),
  -- Set by the worker each time a web search ran for this profile (quota allocator).
  last_web_search_at  timestamptz
);

create table public.profile_members (
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  user_id     uuid not null unique references auth.users (id) on delete cascade,
  role        text not null default 'member' check (role in ('owner', 'member')),
  joined_at   timestamptz not null default now(),
  primary key (profile_id, user_id)
);

create table public.keyword_rules (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null references public.profiles (id) on delete cascade,
  term           text not null check (length(trim(term)) > 0),
  -- Non-empty => `term` is ambiguous and only counts together with one of these words.
  context_terms  text[] not null default '{}',
  -- true => any item containing `term` is rejected (context_terms ignored).
  is_exclusion   boolean not null default false,
  created_at     timestamptz not null default now()
);
create index keyword_rules_profile_idx on public.keyword_rules (profile_id);

create table public.invites (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  token       text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  used_at     timestamptz,
  used_by     uuid references auth.users (id) on delete set null
);
create index invites_profile_idx on public.invites (profile_id);

create table public.mentions (
  id                  uuid primary key default gen_random_uuid(),
  profile_id          uuid not null references public.profiles (id) on delete cascade,
  url                 text not null,
  title               text not null,
  snippet             text not null default '',
  source_type         text not null
                      check (source_type in ('google_news', 'gdelt', 'reddit', 'web_search')),
  -- Human-readable origin: publisher domain, "r/subreddit", etc.
  source_name         text not null,
  published_at        timestamptz,
  fetched_at          timestamptz not null default now(),
  reach_score         real not null default 0 check (reach_score >= 0 and reach_score <= 1),
  -- Sentiment fields stay NULL in v1 (NullClassifier). Jev fills them later.
  sentiment           text check (sentiment in ('positive', 'neutral', 'negative')),
  sentiment_score     real,
  confidence          real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  classifier_version  text,
  -- true => a member marked it "Not relevant".
  hidden              boolean not null default false,
  unique (profile_id, url, source_type)
);
create index mentions_profile_published_idx on public.mentions (profile_id, published_at desc nulls last);
create index mentions_profile_reach_idx on public.mentions (profile_id, reach_score desc);

create table public.runs (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('hourly', 'backfill')),
  -- NULL for hourly runs (they cover all profiles); set for backfill runs.
  profile_id   uuid references public.profiles (id) on delete cascade,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running', 'success', 'failed')),
  -- Aggregate counters only (no other profiles' names/terms), e.g.
  -- {"fetched": 120, "matched": 14, "inserted": 9, "per_source": {"reddit": 3}}
  stats        jsonb not null default '{}',
  error        text
);
create index runs_started_idx on public.runs (started_at desc);

create table public.quota_usage (
  provider      text not null check (provider in ('tavily', 'exa', 'serper')),
  -- First day of the month (UTC). One-time quotas (Serper) are summed over all rows.
  month         date not null check (extract(day from month) = 1),
  credits_used  numeric not null default 0 check (credits_used >= 0),
  primary key (provider, month)
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.is_profile_member(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profile_members
    where profile_id = pid and user_id = auth.uid()
  );
$$;

create or replace function public.my_profile_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select profile_id from public.profile_members where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- RPCs (called from the web app)
-- ---------------------------------------------------------------------------

-- Creates a profile with the caller as owner. `rules` is a JSON array of
-- {"term": text, "context_terms": [text], "is_exclusion": bool}.
create or replace function public.create_profile(
  p_name text,
  p_website_url text default null,
  p_social_links text[] default '{}',
  p_rules jsonb default '[]'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  pid uuid;
  r jsonb;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if exists (select 1 from profile_members where user_id = uid) then
    raise exception 'user already belongs to a profile' using errcode = '23505';
  end if;

  insert into profiles (name, website_url, social_links)
  values (p_name, nullif(trim(p_website_url), ''), coalesce(p_social_links, '{}'))
  returning id into pid;

  insert into profile_members (profile_id, user_id, role) values (pid, uid, 'owner');

  for r in select * from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) loop
    insert into keyword_rules (profile_id, term, context_terms, is_exclusion)
    values (
      pid,
      r->>'term',
      coalesce(array(select jsonb_array_elements_text(r->'context_terms')), '{}'),
      coalesce((r->>'is_exclusion')::boolean, false)
    );
  end loop;

  return pid;
end;
$$;

-- Joins the profile behind a valid, unused, unexpired invite token.
create or replace function public.accept_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  inv invites%rowtype;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if exists (select 1 from profile_members where user_id = uid) then
    raise exception 'user already belongs to a profile' using errcode = '23505';
  end if;

  select * into inv from invites where token = p_token for update;
  if not found or inv.used_at is not null or inv.expires_at < now() then
    raise exception 'invite is invalid, used or expired' using errcode = 'P0002';
  end if;

  insert into profile_members (profile_id, user_id, role) values (inv.profile_id, uid, 'member');
  update invites set used_at = now(), used_by = uid where id = inv.id;
  return inv.profile_id;
end;
$$;

-- Leaves the caller's profile. The profile (and its data) is deleted when the
-- last member leaves; otherwise ownership passes to the longest-standing member.
create or replace function public.leave_profile()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  pid uuid;
  was_owner boolean;
begin
  select profile_id, role = 'owner' into pid, was_owner
  from profile_members where user_id = uid;
  if pid is null then
    return;
  end if;

  delete from profile_members where user_id = uid;

  if not exists (select 1 from profile_members where profile_id = pid) then
    delete from profiles where id = pid;
  elsif was_owner and not exists (
    select 1 from profile_members where profile_id = pid and role = 'owner'
  ) then
    update profile_members set role = 'owner'
    where profile_id = pid
      and user_id = (select user_id from profile_members where profile_id = pid order by joined_at limit 1);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges and Row Level Security
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon;
revoke all on function
  public.is_profile_member(uuid),
  public.my_profile_id(),
  public.create_profile(text, text, text[], jsonb),
  public.accept_invite(text),
  public.leave_profile()
from public, anon;

grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant update (name, website_url, social_links) on public.profiles to authenticated;
grant select on public.profile_members to authenticated;
grant select, insert, update, delete on public.keyword_rules to authenticated;
grant select, insert on public.invites to authenticated;
grant select on public.mentions to authenticated;
grant update (hidden) on public.mentions to authenticated;
grant select on public.runs to authenticated;
grant select on public.quota_usage to authenticated;
grant execute on function
  public.is_profile_member(uuid),
  public.my_profile_id(),
  public.create_profile(text, text, text[], jsonb),
  public.accept_invite(text),
  public.leave_profile()
to authenticated;

alter table public.profiles        enable row level security;
alter table public.profile_members enable row level security;
alter table public.keyword_rules   enable row level security;
alter table public.invites         enable row level security;
alter table public.mentions        enable row level security;
alter table public.runs            enable row level security;
alter table public.quota_usage     enable row level security;

create policy profiles_select on public.profiles
  for select to authenticated using (public.is_profile_member(id));
create policy profiles_update on public.profiles
  for update to authenticated using (public.is_profile_member(id)) with check (public.is_profile_member(id));

create policy members_select on public.profile_members
  for select to authenticated using (public.is_profile_member(profile_id));

create policy rules_all on public.keyword_rules
  for all to authenticated
  using (public.is_profile_member(profile_id))
  with check (public.is_profile_member(profile_id));

create policy invites_select on public.invites
  for select to authenticated using (public.is_profile_member(profile_id));
create policy invites_insert on public.invites
  for insert to authenticated
  with check (public.is_profile_member(profile_id) and created_by = auth.uid());

create policy mentions_select on public.mentions
  for select to authenticated using (public.is_profile_member(profile_id));
create policy mentions_update on public.mentions
  for update to authenticated
  using (public.is_profile_member(profile_id))
  with check (public.is_profile_member(profile_id));

create policy runs_select on public.runs
  for select to authenticated
  using (profile_id is null or public.is_profile_member(profile_id));

create policy quota_select on public.quota_usage
  for select to authenticated using (true);
