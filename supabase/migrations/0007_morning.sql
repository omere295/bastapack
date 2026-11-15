-- morning (Green Invoice) connection: FIRE and client sync run in the `morning` Edge Function.
-- These functions are its database side and can only be called with the service role.

alter table public.orders add column if not exists fire_started_at timestamptz;

-- Claims an order for FIRE so a double tap cannot create two delivery notes.
-- Returns the order's id when it may be fired now; raises a Hebrew error otherwise.
create or replace function public.claim_fire(p_order uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if not found or o.deleted_at is not null then raise exception 'ההזמנה לא נמצאה'; end if;
  if o.kind <> 'business' then raise exception 'רק הזמנה עסקית מופקת במורנינג'; end if;
  if o.status = 'fired' then raise exception 'ההזמנה כבר הופקה (מסמך %)', o.morning_doc_number; end if;
  if o.status <> 'packed' then raise exception 'יש לארוז את ההזמנה לפני ההפקה'; end if;
  if o.fire_started_at is not null and o.fire_started_at > now() - interval '2 minutes' then
    raise exception 'ההפקה כבר בתהליך. חכו רגע ורעננו.';
  end if;
  update public.orders set fire_started_at = now() where id = p_order;
  return p_order;
end $$;

create or replace function public.finish_fire(p_order uuid, p_doc_id text, p_doc_number text, p_doc_url text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.orders set status = 'fired', fired_at = now(), fire_started_at = null,
    morning_doc_id = p_doc_id, morning_doc_number = p_doc_number, morning_doc_url = p_doc_url
  where id = p_order;
  insert into public.activity_log (actor, action, order_id, order_number, details)
  select 'admin', 'fired', o.id, o.number, jsonb_build_object('doc', p_doc_number) from public.orders o where o.id = p_order;
end $$;

create or replace function public.release_fire(p_order uuid) returns void
language sql security definer set search_path = '' as $$
  update public.orders set fire_started_at = null where id = p_order and status <> 'fired';
$$;

-- Upserts clients from morning. Matches by morning id, then by company number, then by name.
-- morning is the source for legal name, company number, contact, phone and address;
-- the business name shown in the app is only set when the client is new.
create or replace function public.sync_morning_clients(p_clients jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c jsonb; v_id uuid; added int := 0; updated int := 0;
begin
  for c in select * from jsonb_array_elements(p_clients) loop
    select id into v_id from public.clients where morning_id = c ->> 'morning_id';
    if v_id is null and coalesce(c ->> 'company_number', '') <> '' then
      select id into v_id from public.clients where morning_id is null and company_number = c ->> 'company_number' limit 1;
    end if;
    if v_id is null then
      select id into v_id from public.clients where morning_id is null
        and (business_name = c ->> 'name' or legal_name = c ->> 'name') limit 1;
    end if;
    if v_id is null then
      insert into public.clients (morning_id, business_name, legal_name, company_number, contact_name, phone, address, active, synced_at)
      values (c ->> 'morning_id', c ->> 'name', c ->> 'name', nullif(c ->> 'company_number', ''), nullif(c ->> 'contact_name', ''),
              nullif(c ->> 'phone', ''), coalesce(c -> 'address', '{}'::jsonb), coalesce((c ->> 'active')::boolean, true), now());
      added := added + 1;
    else
      update public.clients set morning_id = c ->> 'morning_id', legal_name = c ->> 'name',
        company_number = coalesce(nullif(c ->> 'company_number', ''), company_number),
        contact_name = coalesce(nullif(c ->> 'contact_name', ''), contact_name),
        phone = coalesce(nullif(c ->> 'phone', ''), phone),
        address = case when coalesce(c -> 'address' ->> 'street', '') <> '' then c -> 'address' else address end,
        active = coalesce((c ->> 'active')::boolean, active), synced_at = now()
      where id = v_id;
      updated := updated + 1;
    end if;
  end loop;
  return jsonb_build_object('added', added, 'updated', updated);
end $$;

revoke all on function public.claim_fire(uuid), public.finish_fire(uuid, text, text, text), public.release_fire(uuid),
  public.sync_morning_clients(jsonb) from public, anon, authenticated;
grant execute on function public.claim_fire(uuid), public.finish_fire(uuid, text, text, text), public.release_fire(uuid),
  public.sync_morning_clients(jsonb) to service_role;
