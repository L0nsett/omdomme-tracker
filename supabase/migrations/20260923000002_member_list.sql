-- Members of the caller's profile with their e-mail (auth.users is not readable
-- from the web app). Part of the phase 0 contract.
create or replace function public.list_profile_members()
returns table (user_id uuid, email text, role text, joined_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.user_id, u.email::text, m.role, m.joined_at
  from public.profile_members m
  join auth.users u on u.id = m.user_id
  where m.profile_id = public.my_profile_id()
  order by m.joined_at;
$$;

revoke all on function public.list_profile_members() from public, anon;
grant execute on function public.list_profile_members() to authenticated;
