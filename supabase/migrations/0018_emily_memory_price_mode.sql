-- Emily's permanent memory, and each business client's price list type (26/11/2026).
--
-- assistant_memory: things the owner or staff teach Emily on WhatsApp ("Brasserie always gets the fish cleaned").
--   They stay until someone tells Emily to forget or change them, or an admin removes them in Settings.
--   Removal is soft (deleted_at), like orders.
-- clients.price_mode: null = not asked yet (Emily asks "יש לו מחירים מיוחדים?" the first time the client comes up),
--   'regular' = always the regular morning price, 'special' = the client's own prices (client_prices).
--   Saving any client price marks a client that was not asked yet as 'special'.

create table public.assistant_memory (
  id uuid primary key default gen_random_uuid(),
  fact text not null check (length(trim(fact)) between 1 and 500),
  client_id uuid references public.clients(id) on delete cascade,
  taught_by text,                        -- the WhatsApp number that taught it, or 'admin'
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index assistant_memory_active on public.assistant_memory (created_at) where deleted_at is null;
alter table public.assistant_memory enable row level security;
create policy memory_admin_read on public.assistant_memory for select to authenticated using (public.is_admin());
create policy memory_admin_update on public.assistant_memory for update to authenticated using (public.is_admin()) with check (public.is_admin());

alter table public.clients add column price_mode text check (price_mode in ('regular', 'special'));

create or replace function public.mark_special_prices() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.clients set price_mode = 'special' where id = new.client_id and price_mode is null;
  return new;
end $$;
create trigger client_prices_mark_special after insert on public.client_prices
  for each row execute function public.mark_special_prices();
revoke all on function public.mark_special_prices() from public, anon, authenticated;

-- Clients that already have saved prices count as 'special'.
update public.clients c set price_mode = 'special'
where price_mode is null and exists (select 1 from public.client_prices p where p.client_id = c.id);

create or replace function public.wa_set_price_mode(p_client uuid, p_mode text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_mode not in ('regular', 'special') then raise exception 'סוג מחירון לא תקין'; end if;
  update public.clients set price_mode = p_mode where id = p_client;
  if not found then raise exception 'לקוח לא נמצא'; end if;
end $$;
revoke all on function public.wa_set_price_mode(uuid, text) from public, anon, authenticated;
grant execute on function public.wa_set_price_mode(uuid, text) to service_role;
