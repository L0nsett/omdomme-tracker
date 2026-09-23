-- Phase 3 review fixes. No changes to tables, columns or allowed values.
--
-- H1: hosted Supabase grants ALL on every new public table/function/sequence to
--     anon and authenticated by default. Revoke everything and grant back only
--     what the web app needs, so the column-level grants actually restrict.
-- H2: size limits enforced in the database (not only in the web form), so one
--     user can't create a profile with thousands of search terms and drain the
--     shared web search quota.
-- L1: leave_profile locks the profile row so two last members leaving at the
--     same time can't leave an orphaned profile behind.

-- ---------------------------------------------------------------------------
-- H1: privileges
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated, public;

grant select on public.profiles to authenticated;
grant update (name, website_url, social_links) on public.profiles to authenticated;
grant select on public.profile_members to authenticated;
grant select, insert, update, delete on public.keyword_rules to authenticated;
grant select on public.invites to authenticated;
-- Clients may only choose the profile and themselves as creator; token, expiry
-- and use are set by defaults and accept_invite().
grant insert (profile_id, created_by) on public.invites to authenticated;
grant select on public.mentions to authenticated;
grant update (hidden) on public.mentions to authenticated;
grant select on public.runs to authenticated;
grant select on public.quota_usage to authenticated;

-- ---------------------------------------------------------------------------
-- H2: size limits (same numbers as web/src/lib/auth/profile-form.ts)
-- ---------------------------------------------------------------------------

alter table public.profiles
  add constraint profiles_name_length check (char_length(name) <= 120),
  add constraint profiles_website_length check (website_url is null or char_length(website_url) <= 500),
  add constraint profiles_social_links_count check (cardinality(social_links) <= 20);

alter table public.keyword_rules
  add constraint keyword_rules_term_length check (char_length(term) <= 100),
  add constraint keyword_rules_context_count check (cardinality(context_terms) <= 20);

create or replace function public.enforce_keyword_rule_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Serialise inserts per profile so concurrent inserts can't pass the limit together.
  perform 1 from profiles where id = new.profile_id for update;
  if (select count(*) from keyword_rules where profile_id = new.profile_id) >= 50 then
    raise exception 'a profile can have at most 50 keyword rules' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_keyword_rule_limit() from public, anon, authenticated;

create trigger keyword_rules_limit
  before insert on public.keyword_rules
  for each row execute function public.enforce_keyword_rule_limit();

-- ---------------------------------------------------------------------------
-- L1: leave_profile with a row lock
-- ---------------------------------------------------------------------------

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
  select profile_id into pid from profile_members where user_id = uid;
  if pid is null then
    return;
  end if;
  perform 1 from profiles where id = pid for update;
  select role = 'owner' into was_owner from profile_members where user_id = uid;

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
