-- BastaPack: actions staff take on orders.
-- Employees can only change orders through these functions. Each one checks the caller's role,
-- refuses to touch fired or deleted orders, and writes to activity_log.
-- Errors are raised in Hebrew because the app shows them to staff as-is.

create sequence if not exists public.manual_order_seq start 501;

create or replace function public.current_actor() returns text
language sql stable set search_path = '' as $$
  select case when public.is_admin() then 'admin' else 'employee' end
$$;

create or replace function public.log_action(p_action text, p_order uuid, p_details jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.activity_log (actor, action, order_id, order_number, details)
  select public.current_actor(), p_action, o.id, o.number, coalesce(p_details, '{}'::jsonb)
  from public.orders o where o.id = p_order;
end $$;
revoke all on function public.log_action(text, uuid, jsonb) from public, anon, authenticated;

-- Loads an order for an edit; raises if the caller may not edit it.
create or replace function public.editable_order(p_order uuid) returns public.orders
language plpgsql stable security definer set search_path = '' as $$
declare o public.orders;
begin
  if not public.is_staff() then raise exception 'אין הרשאה' using errcode = '42501'; end if;
  select * into o from public.orders where id = p_order;
  if not found or o.deleted_at is not null then raise exception 'ההזמנה לא נמצאה'; end if;
  if o.status = 'fired' then raise exception 'ההזמנה הופקה במורנינג ולכן נעולה'; end if;
  return o;
end $$;
revoke all on function public.editable_order(uuid) from public, anon;

-- ---------- packing ----------
create or replace function public.set_item_final(p_item uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare it public.order_items; o public.orders;
begin
  select * into it from public.order_items where id = p_item and removed_at is null;
  if not found then raise exception 'הפריט לא נמצא'; end if;
  o := public.editable_order(it.order_id);
  if p_amount is null or p_amount < 0 then raise exception 'כמות לא תקינה'; end if;
  if it.unit = 'kg' and (p_amount <= 0 or p_amount > 200) then raise exception 'משקל בין 0.01 ל-200 ק״ג'; end if;
  if it.unit = 'unit' and p_amount <> trunc(p_amount) then raise exception 'כמות צריכה להיות מספר שלם'; end if;
  update public.order_items set final_amount = p_amount, confirmed = true where id = p_item;
  if it.confirmed and it.final_amount is distinct from p_amount then
    perform public.log_action('weight_changed', o.id, jsonb_build_object('item', it.name, 'from', it.final_amount, 'to', p_amount));
  end if;
end $$;

create or replace function public.pack_order(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; missing text;
begin
  o := public.editable_order(p_order);
  if o.status = 'packed' then return; end if;
  if not exists (select 1 from public.order_items where order_id = p_order and removed_at is null) then
    raise exception 'אין פריטים בהזמנה';
  end if;
  select string_agg(name, ', ' order by position) into missing
    from public.order_items where order_id = p_order and removed_at is null and not confirmed;
  if missing is not null then raise exception 'חסר אישור משקל ל: %', missing; end if;
  update public.orders set status = 'packed', packed_at = now() where id = p_order;
  perform public.log_action('packed', p_order);
end $$;

create or replace function public.unpack_order(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  o := public.editable_order(p_order);
  if o.status <> 'packed' then return; end if;
  update public.orders set status = 'new', packed_at = null where id = p_order;
  perform public.log_action('unpacked', p_order);
end $$;

create or replace function public.add_item(p_order uuid, p_product uuid, p_amount numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.orders; p public.products; new_id uuid; next_pos int;
begin
  o := public.editable_order(p_order);
  select * into p from public.products where id = p_product and active;
  if not found then raise exception 'המוצר לא נמצא'; end if;
  if p_amount is null or p_amount <= 0 or (p.unit = 'unit' and p_amount <> trunc(p_amount)) then
    raise exception 'כמות לא תקינה';
  end if;
  select coalesce(max(position), 0) + 1 into next_pos from public.order_items where order_id = p_order;
  insert into public.order_items (order_id, product_id, name, unit, ordered_count, ordered_kg, added_during_packing, position)
  values (p_order, p.id, p.name, p.unit,
          case when p.unit = 'unit' then p_amount end,
          case when p.unit = 'kg' then p_amount end,
          o.kind = 'private', next_pos)
  returning id into new_id;
  if o.status = 'packed' then update public.orders set status = 'new', packed_at = null where id = p_order; end if;
  perform public.log_action('item_added', p_order, jsonb_build_object('item', p.name, 'amount', p_amount));
  return new_id;
end $$;

create or replace function public.remove_item(p_item uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare it public.order_items; o public.orders;
begin
  select * into it from public.order_items where id = p_item and removed_at is null;
  if not found then raise exception 'הפריט לא נמצא'; end if;
  o := public.editable_order(it.order_id);
  update public.order_items set removed_at = now() where id = p_item;
  if o.status = 'packed' and not exists (select 1 from public.order_items where order_id = o.id and removed_at is null) then
    update public.orders set status = 'new', packed_at = null where id = o.id;
  end if;
  perform public.log_action('item_removed', o.id, jsonb_build_object('item', it.name));
end $$;

create or replace function public.set_pickup(p_order uuid, p_pickup boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  o := public.editable_order(p_order);
  if o.kind <> 'business' and not public.is_admin() then raise exception 'אין הרשאה'; end if;
  if not p_pickup and extract(isodow from o.delivery_date) not between 1 and 5 then
    raise exception 'ביום ראשון יש איסוף עצמי בלבד';
  end if;
  update public.orders set pickup = p_pickup where id = p_order;
  perform public.log_action(case when p_pickup then 'pickup_on' else 'pickup_off' end, p_order);
end $$;

-- ---------- admin ----------
create or replace function public.require_admin() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'פעולה למנהל בלבד' using errcode = '42501'; end if;
end $$;

-- Soft-deletes orders; fired orders are skipped. Returns how many were deleted.
create or replace function public.delete_orders(p_ids uuid[]) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  perform public.require_admin();
  for r in select id from public.orders where id = any(p_ids) and deleted_at is null and status <> 'fired' loop
    update public.orders set deleted_at = now() where id = r.id;
    perform public.log_action('deleted', r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.restore_order(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  update public.orders set deleted_at = null where id = p_order and deleted_at is not null;
  if found then perform public.log_action('restored', p_order); end if;
end $$;

-- Updates order details. p holds only the fields to change:
-- delivery_date, time_window, pickup, customer_name, phone, address, client_id, notes.
create or replace function public.update_order(p_order uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  perform public.require_admin();
  o := public.editable_order(p_order);
  update public.orders set
    delivery_date = coalesce((p ->> 'delivery_date')::date, delivery_date),
    time_window   = case when p ? 'time_window' then p ->> 'time_window' else time_window end,
    pickup        = coalesce((p ->> 'pickup')::boolean, pickup),
    customer_name = case when p ? 'customer_name' then p ->> 'customer_name' else customer_name end,
    phone         = case when p ? 'phone' then p ->> 'phone' else phone end,
    address       = case when p ? 'address' then p -> 'address' else address end,
    client_id     = coalesce((p ->> 'client_id')::uuid, client_id),
    notes         = case when p ? 'notes' then p ->> 'notes' else notes end
  where id = p_order;
  perform public.log_action('edited', p_order, p);
end $$;

-- Creates an order by hand. p: {kind, delivery_date, time_window?, pickup?, customer_name?, phone?, address?,
-- client_id?, items: [{product_id, amount, price?}]}. For business orders an item price (₪ per kg/unit)
-- is saved as that client's price. Returns the new order's id.
create or replace function public.create_manual_order(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := p ->> 'kind';
  v_id uuid; v_num text; i jsonb; pr public.products; pos int := 0; amt numeric;
begin
  perform public.require_admin();
  if v_kind not in ('private', 'business') then raise exception 'סוג הזמנה לא תקין'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]'::jsonb)) = 0 then raise exception 'הוסיפו לפחות מוצר אחד'; end if;
  v_num := case when v_kind = 'business' then 'B-' || nextval('public.business_order_seq')
                else 'M-' || nextval('public.manual_order_seq') end;
  insert into public.orders (kind, number, delivery_date, time_window, pickup, customer_name, phone, address, client_id, delivery_fee, source)
  values (v_kind, v_num, (p ->> 'delivery_date')::date, p ->> 'time_window', coalesce((p ->> 'pickup')::boolean, false),
          p ->> 'customer_name', p ->> 'phone', coalesce(p -> 'address', '{}'::jsonb),
          (p ->> 'client_id')::uuid, coalesce((p ->> 'delivery_fee')::numeric, 0), 'manual')
  returning id into v_id;
  for i in select * from jsonb_array_elements(p -> 'items') loop
    select * into pr from public.products where id = (i ->> 'product_id')::uuid;
    if not found then raise exception 'מוצר לא נמצא'; end if;
    amt := (i ->> 'amount')::numeric;
    if amt is null or amt <= 0 or (pr.unit = 'unit' and amt <> trunc(amt)) then raise exception 'כמות לא תקינה עבור %', pr.name; end if;
    pos := pos + 1;
    insert into public.order_items (order_id, product_id, name, unit, ordered_count, ordered_kg, line_price, position)
    values (v_id, pr.id, pr.name, pr.unit,
            case when pr.unit = 'unit' then amt end, case when pr.unit = 'kg' then amt end,
            case when v_kind = 'private' and pr.site_price is not null then round(amt * pr.site_price, 2) end, pos);
    if v_kind = 'business' and (i ->> 'price') is not null then
      insert into public.client_prices (client_id, product_id, price, updated_by)
      values ((p ->> 'client_id')::uuid, pr.id, (i ->> 'price')::numeric, 'admin')
      on conflict (client_id, product_id) do update set price = excluded.price, updated_at = now(), updated_by = 'admin';
    end if;
  end loop;
  perform public.log_action('created', v_id);
  return v_id;
end $$;

-- ---------- who may call what ----------
revoke all on function public.set_item_final(uuid, numeric), public.pack_order(uuid), public.unpack_order(uuid),
  public.add_item(uuid, uuid, numeric), public.remove_item(uuid), public.set_pickup(uuid, boolean),
  public.delete_orders(uuid[]), public.restore_order(uuid), public.update_order(uuid, jsonb),
  public.create_manual_order(jsonb) from public, anon;
grant execute on function public.set_item_final(uuid, numeric), public.pack_order(uuid), public.unpack_order(uuid),
  public.add_item(uuid, uuid, numeric), public.remove_item(uuid), public.set_pickup(uuid, boolean),
  public.delete_orders(uuid[]), public.restore_order(uuid), public.update_order(uuid, jsonb),
  public.create_manual_order(jsonb) to authenticated;

-- ---------- live updates on every device ----------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.orders, public.order_items;
  end if;
end $$;
