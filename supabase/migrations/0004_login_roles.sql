-- Gives the two app logins their role automatically when they are created in Supabase Auth.
-- staff@bastadagim.co.il → employee, admin@bastadagim.co.il → admin. Any other new user gets no role
-- and therefore sees nothing.

create or replace function public.assign_app_role() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if lower(new.email) = 'admin@bastadagim.co.il' then
    new.raw_app_meta_data := coalesce(new.raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}';
  elsif lower(new.email) = 'staff@bastadagim.co.il' then
    new.raw_app_meta_data := coalesce(new.raw_app_meta_data, '{}'::jsonb) || '{"role":"employee"}';
  end if;
  return new;
end $$;
revoke all on function public.assign_app_role() from public, anon, authenticated;

drop trigger if exists assign_app_role on auth.users;
create trigger assign_app_role before insert on auth.users
  for each row execute function public.assign_app_role();

-- If the users already exist, set their roles now.
update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'
  where lower(email) = 'admin@bastadagim.co.il';
update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"employee"}'
  where lower(email) = 'staff@bastadagim.co.il';
