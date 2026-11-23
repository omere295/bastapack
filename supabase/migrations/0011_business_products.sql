-- Business products come from morning (its item list); website (private) products stay as they are.
--   products.catalog = 'private' (website / ClickEat) or 'business' (morning item, morning_item_id set).
--   Business orders may only hold business products and private orders only website products (trigger below),
--   so the app, Emily and the database all agree. Names only need to be unique within the website catalog.
--   sync_morning_items(): called by the `morning` Edge Function (service role) with morning's items.
--   ingest_email(): same as 0006, but matches website products only.

alter table public.products
  add column catalog text not null default 'private' check (catalog in ('private', 'business')),
  add column morning_item_id text unique,
  add column sku text,
  add column list_price numeric(10,2);                 -- price in morning's item list (before VAT), for reference
alter table public.products drop constraint products_name_key;
create unique index products_private_name on public.products (name) where catalog = 'private';

create or replace function public.check_item_catalog() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text; c text;
begin
  if new.product_id is null then return new; end if;
  select kind into k from public.orders where id = new.order_id;
  select catalog into c from public.products where id = new.product_id;
  if k = 'business' and c <> 'business' then raise exception 'בהזמנה עסקית אפשר לבחור רק מוצרים ממורנינג'; end if;
  if k = 'private' and c <> 'private' then raise exception 'בהזמנה פרטית אפשר לבחור רק מוצרים מהאתר'; end if;
  return new;
end $$;
create trigger order_items_catalog before insert or update of product_id on public.order_items
  for each row execute function public.check_item_catalog();
revoke all on function public.check_item_catalog() from public, anon, authenticated;

-- p_items: [{morning_item_id, name, sku, price, active}]
create or replace function public.sync_morning_items(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i jsonb; v_added int := 0; v_updated int := 0; v_off int := 0; v_name text;
begin
  for i in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_name := left(trim(i ->> 'name'), 200);
    if coalesce(i ->> 'morning_item_id', '') = '' or coalesce(v_name, '') = '' then continue; end if;
    update public.products set name = v_name, sku = nullif(i ->> 'sku', ''), list_price = (i ->> 'price')::numeric,
           active = coalesce((i ->> 'active')::boolean, true)
     where morning_item_id = i ->> 'morning_item_id';
    if found then v_updated := v_updated + 1;
    else
      -- unit is a first guess from the name ("יח", "יחידה", "יחידות" → unit, otherwise kg); admin can switch it in settings
      insert into public.products (name, unit, catalog, morning_item_id, sku, list_price, active)
      values (v_name, case when v_name ~ '(^|[^א-ת])(יח|יח׳|יח''|יחידה|יחידות)([^א-ת]|$)' then 'unit' else 'kg' end,
              'business', i ->> 'morning_item_id', nullif(i ->> 'sku', ''), (i ->> 'price')::numeric, coalesce((i ->> 'active')::boolean, true));
      v_added := v_added + 1;
    end if;
  end loop;
  -- items deleted in morning stop showing (kept for old orders and prices); never when morning sent nothing
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then return jsonb_build_object('added', 0, 'updated', 0, 'deactivated', 0); end if;
  update public.products set active = false
   where catalog = 'business' and active and morning_item_id is not null
     and morning_item_id not in (select x ->> 'morning_item_id' from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x);
  get diagnostics v_off = row_count;
  return jsonb_build_object('added', v_added, 'updated', v_updated, 'deactivated', v_off);
end $$;
revoke all on function public.sync_morning_items(jsonb) from public, anon, authenticated;
grant execute on function public.sync_morning_items(jsonb) to service_role;

-- Email intake: unchanged except that it only matches website products.
create or replace function public.ingest_email(p_gmail_id text, p_subject text, p_received timestamptz, p_parsed jsonb, p_problem text, p_html text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ex public.email_inbox; o public.orders; v_order uuid; i jsonb; pr public.products;
  v_unit text; v_kg numeric; v_cnt numeric; v_price numeric; pos int := 0; v_status text := 'imported'; v_problem text := p_problem;
begin
  select * into ex from public.email_inbox where gmail_id = p_gmail_id;
  if found then return jsonb_build_object('status', ex.status, 'order_id', ex.order_id, 'duplicate', true); end if;

  -- Orders for days that have already passed (e.g. older emails on the first run) are logged, not imported.
  if p_parsed is not null and (p_parsed ->> 'delivery_date')::date < (now() at time zone 'Asia/Jerusalem')::date then
    insert into public.email_inbox (gmail_id, received_at, subject, status, problem, order_id)
    values (p_gmail_id, p_received, p_subject, 'ignored', 'תאריך ההזמנה כבר עבר', null);
    return jsonb_build_object('status', 'ignored');
  end if;

  if v_problem is null and p_parsed is not null then
    begin
      select * into o from public.orders where kind = 'private' and number = p_parsed ->> 'number';
      if found and (o.status <> 'new' or o.deleted_at is not null
                    or exists (select 1 from public.order_items where order_id = o.id and confirmed and removed_at is null)) then
        v_problem := 'הגיע עדכון להזמנה ' || o.number || ' שכבר התחילו לארוז או שנמחקה. בדקו ידנית.';
      elsif not coalesce((p_parsed ->> 'pickup')::boolean, false)
            and extract(isodow from (p_parsed ->> 'delivery_date')::date) not between 1 and 5 then
        v_problem := 'משלוח ליום שאין בו משלוחים (' || (p_parsed ->> 'delivery_date') || ')';
      else
        if found then
          v_status := 'updated'; v_order := o.id;
          update public.orders set delivery_date = (p_parsed ->> 'delivery_date')::date, time_window = p_parsed ->> 'time_window',
            pickup = (p_parsed ->> 'pickup')::boolean, customer_name = p_parsed ->> 'customer_name', phone = p_parsed ->> 'phone',
            address = coalesce(p_parsed -> 'address', '{}'::jsonb), delivery_fee = coalesce((p_parsed ->> 'delivery_fee')::numeric, 0)
          where id = o.id;
          delete from public.order_items where order_id = o.id;
        else
          insert into public.orders (kind, number, delivery_date, time_window, pickup, customer_name, phone, address, delivery_fee, source, source_ref)
          values ('private', p_parsed ->> 'number', (p_parsed ->> 'delivery_date')::date, p_parsed ->> 'time_window',
                  (p_parsed ->> 'pickup')::boolean, p_parsed ->> 'customer_name', p_parsed ->> 'phone',
                  coalesce(p_parsed -> 'address', '{}'::jsonb), coalesce((p_parsed ->> 'delivery_fee')::numeric, 0), 'email', p_gmail_id)
          returning id into v_order;
        end if;
        for i in select * from jsonb_array_elements(p_parsed -> 'items') loop
          v_kg := (i ->> 'kg')::numeric; v_cnt := (i ->> 'count')::numeric; v_price := (i ->> 'price')::numeric;
          v_unit := case when v_kg is not null and v_kg > 0 then 'kg' else 'unit' end;
          -- the catalog builds itself from the products customers actually order
          select * into pr from public.products where name = i ->> 'name' and catalog = 'private';
          if not found then
            insert into public.products (name, unit, site_price)
            values (i ->> 'name', v_unit, round(v_price / nullif(case when v_unit = 'kg' then v_kg else v_cnt end, 0), 2))
            returning * into pr;
          end if;
          pos := pos + 1;
          insert into public.order_items (order_id, product_id, name, unit, ordered_count, ordered_kg, line_price, option, note, position)
          values (v_order, pr.id, i ->> 'name', v_unit, v_cnt, case when v_unit = 'kg' then v_kg end, v_price,
                  coalesce(i ->> 'option', ''), coalesce(i ->> 'note', ''), pos);
        end loop;
        insert into public.activity_log (actor, action, order_id, order_number, details)
        values ('system', case when v_status = 'updated' then 'email_updated' else 'email_imported' end, v_order, p_parsed ->> 'number', '{}'::jsonb);
      end if;
    exception when others then
      v_problem := 'שגיאה בקליטה: ' || sqlerrm; v_order := null; v_status := 'imported';
    end;
  end if;

  insert into public.email_inbox (gmail_id, received_at, subject, status, problem, parsed, html, order_id)
  values (p_gmail_id, p_received, p_subject, case when v_problem is null then v_status else 'review' end, v_problem, p_parsed,
          case when v_problem is null then null else p_html end, v_order);
  return jsonb_build_object('status', case when v_problem is null then v_status else 'review' end, 'order_id', v_order, 'problem', v_problem);
end $$;
