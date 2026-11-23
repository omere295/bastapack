-- WhatsApp assistant (Edge Function `whatsapp`).
-- Messages are kept for conversation context. Risky actions (cancel, price change, allowed numbers)
-- wait in wa_pending until the sender replies YES. Order changes made here are logged as 'whatsapp'.

create table public.wa_messages (
  id text primary key,                         -- WhatsApp message id (incoming) or our own id (outgoing)
  phone text not null,                         -- E.164, e.g. +9725…
  direction text not null check (direction in ('in', 'out')),
  body text not null,
  created_at timestamptz not null default now()
);
create index wa_messages_by_phone on public.wa_messages (phone, created_at desc);

create table public.wa_pending (
  phone text primary key,
  action text not null,
  args jsonb not null,
  summary text not null,
  created_at timestamptz not null default now()
);

alter table public.wa_messages enable row level security;
alter table public.wa_pending enable row level security;
create policy wa_messages_read on public.wa_messages for select to authenticated using (public.is_admin());

create or replace function public.wa_log(p_action text, p_order uuid, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.activity_log (actor, action, order_id, order_number, details)
  select 'whatsapp', p_action, o.id, o.number, coalesce(p_details, '{}'::jsonb) from public.orders o where o.id = p_order;
$$;

-- items: [{product_id, amount}]
create or replace function public.wa_create_order(p_client uuid, p_date date, p_pickup boolean, p_items jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_num text; i jsonb; pr public.products; pos int := 0; amt numeric;
begin
  if not exists (select 1 from public.clients where id = p_client) then raise exception 'הלקוח לא נמצא'; end if;
  if p_date < (now() at time zone 'Asia/Jerusalem')::date then raise exception 'התאריך כבר עבר'; end if;
  if extract(isodow from p_date) = 6 or exists (select 1 from public.holidays where day = p_date) then raise exception 'החנות סגורה ביום הזה'; end if;
  if not coalesce(p_pickup, false) and extract(isodow from p_date) not between 1 and 5 then raise exception 'ביום ראשון יש איסוף עצמי בלבד'; end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then raise exception 'אין פריטים'; end if;
  v_num := 'B-' || nextval('public.business_order_seq');
  insert into public.orders (kind, number, delivery_date, pickup, client_id, source, notes)
  values ('business', v_num, p_date, coalesce(p_pickup, false), p_client, 'whatsapp', p_note) returning id into v_id;
  for i in select * from jsonb_array_elements(p_items) loop
    select * into pr from public.products where id = (i ->> 'product_id')::uuid;
    if not found then raise exception 'מוצר לא נמצא'; end if;
    amt := (i ->> 'amount')::numeric;
    if amt is null or amt <= 0 or (pr.unit = 'unit' and amt <> trunc(amt)) then raise exception 'כמות לא תקינה עבור %', pr.name; end if;
    pos := pos + 1;
    insert into public.order_items (order_id, product_id, name, unit, ordered_count, ordered_kg, position)
    values (v_id, pr.id, pr.name, pr.unit, case when pr.unit = 'unit' then amt end, case when pr.unit = 'kg' then amt end, pos);
  end loop;
  perform public.wa_log('created', v_id);
  return jsonb_build_object('id', v_id, 'number', v_num);
end $$;

-- p: {delivery_date?, pickup?, items?: [{product_id, amount}] (replaces all items; only before packing starts)}
create or replace function public.wa_update_order(p_number text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.orders; i jsonb; pr public.products; pos int := 0; amt numeric; d date;
begin
  select * into o from public.orders where number = p_number and deleted_at is null;
  if not found then raise exception 'הזמנה % לא נמצאה', p_number; end if;
  if o.status = 'fired' then raise exception 'ההזמנה הופקה במורנינג ולכן נעולה'; end if;
  d := coalesce((p ->> 'delivery_date')::date, o.delivery_date);
  if extract(isodow from d) = 6 then raise exception 'החנות סגורה בשבת'; end if;
  if not coalesce((p ->> 'pickup')::boolean, o.pickup) and extract(isodow from d) not between 1 and 5 then raise exception 'ביום ראשון יש איסוף עצמי בלבד'; end if;
  update public.orders set delivery_date = d, pickup = coalesce((p ->> 'pickup')::boolean, pickup) where id = o.id;
  if p ? 'items' then
    if exists (select 1 from public.order_items where order_id = o.id and confirmed and removed_at is null) or o.status <> 'new' then
      raise exception 'כבר התחילו לארוז את ההזמנה. שינוי פריטים נעשה באפליקציה.';
    end if;
    delete from public.order_items where order_id = o.id;
    for i in select * from jsonb_array_elements(p -> 'items') loop
      select * into pr from public.products where id = (i ->> 'product_id')::uuid;
      if not found then raise exception 'מוצר לא נמצא'; end if;
      amt := (i ->> 'amount')::numeric;
      if amt is null or amt <= 0 or (pr.unit = 'unit' and amt <> trunc(amt)) then raise exception 'כמות לא תקינה עבור %', pr.name; end if;
      pos := pos + 1;
      insert into public.order_items (order_id, product_id, name, unit, ordered_count, ordered_kg, position)
      values (o.id, pr.id, pr.name, pr.unit, case when pr.unit = 'unit' then amt end, case when pr.unit = 'kg' then amt end, pos);
    end loop;
  end if;
  perform public.wa_log('edited', o.id, p);
  return jsonb_build_object('number', o.number);
end $$;

create or replace function public.wa_cancel_order(p_number text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where number = p_number and deleted_at is null;
  if not found then raise exception 'הזמנה % לא נמצאה', p_number; end if;
  if o.status = 'fired' then raise exception 'ההזמנה הופקה במורנינג ולא ניתן לבטל אותה כאן'; end if;
  update public.orders set deleted_at = now() where id = o.id;
  perform public.wa_log('deleted', o.id);
  return jsonb_build_object('number', o.number);
end $$;

create or replace function public.wa_set_price(p_client uuid, p_product uuid, p_price numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_price is null or p_price <= 0 then raise exception 'מחיר לא תקין'; end if;
  insert into public.client_prices (client_id, product_id, price, updated_by) values (p_client, p_product, p_price, 'whatsapp')
  on conflict (client_id, product_id) do update set price = excluded.price, updated_at = now(), updated_by = 'whatsapp';
end $$;

create or replace function public.wa_add_alias(p_client uuid, p_alias text) returns void
language sql security definer set search_path = '' as $$
  update public.clients set aliases = array_append(aliases, trim(p_alias))
  where id = p_client and not (trim(p_alias) = any(aliases)) and trim(p_alias) <> '';
$$;

revoke all on function public.wa_log(text, uuid, jsonb), public.wa_create_order(uuid, date, boolean, jsonb, text),
  public.wa_update_order(text, jsonb), public.wa_cancel_order(text), public.wa_set_price(uuid, uuid, numeric),
  public.wa_add_alias(uuid, text) from public, anon, authenticated;
grant execute on function public.wa_log(text, uuid, jsonb), public.wa_create_order(uuid, date, boolean, jsonb, text),
  public.wa_update_order(text, jsonb), public.wa_cancel_order(text), public.wa_set_price(uuid, uuid, numeric),
  public.wa_add_alias(uuid, text) to service_role;
