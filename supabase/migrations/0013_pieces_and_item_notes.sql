-- Emily: business orders can ask for pieces of a weighed product ("2 יח׳ פילה סלמון"): the item keeps the count
-- (ordered_count) with no ordered weight, and the real weight is entered while packing and is what gets invoiced.
-- Each item can also carry its own note ("לפלט, להביא ראש ואידרה").
-- Same functions as 0010 otherwise.

-- items: [{product_id, amount, pieces?, note?}]
create or replace function public.wa_create_order(p_client uuid, p_date date, p_pickup boolean, p_items jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_num text; i jsonb; pr public.products; pos int := 0; amt numeric; pcs boolean;
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
    pcs := pr.unit = 'kg' and coalesce((i ->> 'pieces')::boolean, false);
    if amt is null or amt <= 0 or ((pr.unit = 'unit' or pcs) and amt <> trunc(amt)) then raise exception 'כמות לא תקינה עבור %', pr.name; end if;
    pos := pos + 1;
    insert into public.order_items (order_id, product_id, name, unit, ordered_count, ordered_kg, note, position)
    values (v_id, pr.id, pr.name, pr.unit, case when pr.unit = 'unit' or pcs then amt end, case when pr.unit = 'kg' and not pcs then amt end,
            coalesce(i ->> 'note', ''), pos);
  end loop;
  perform public.wa_log('created', v_id);
  return jsonb_build_object('id', v_id, 'number', v_num);
end $$;

-- p: {delivery_date?, pickup?, items?: [{product_id, amount}] (replaces all items; only before packing starts)}
create or replace function public.wa_update_order(p_number text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.orders; i jsonb; pr public.products; pos int := 0; amt numeric; d date; pcs boolean;
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
      pcs := pr.unit = 'kg' and coalesce((i ->> 'pieces')::boolean, false);
      if amt is null or amt <= 0 or ((pr.unit = 'unit' or pcs) and amt <> trunc(amt)) then raise exception 'כמות לא תקינה עבור %', pr.name; end if;
      pos := pos + 1;
      insert into public.order_items (order_id, product_id, name, unit, ordered_count, ordered_kg, note, position)
      values (o.id, pr.id, pr.name, pr.unit, case when pr.unit = 'unit' or pcs then amt end, case when pr.unit = 'kg' and not pcs then amt end,
              coalesce(i ->> 'note', ''), pos);
    end loop;
  end if;
  perform public.wa_log('edited', o.id, p);
  return jsonb_build_object('number', o.number);
end $$;

