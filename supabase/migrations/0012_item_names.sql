-- morning items in this account keep the catalogue number in "name" and the product name in "description".
-- The `morning` function now sends the real name (and the number as SKU). Items first synced under their number
-- got their unit guessed from the number, so guess it again from the real name when the name changes from a number.
create or replace function public.sync_morning_items(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i jsonb; v_added int := 0; v_updated int := 0; v_off int := 0; v_name text; v_unit text;
begin
  for i in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_name := left(trim(i ->> 'name'), 200);
    if coalesce(i ->> 'morning_item_id', '') = '' or coalesce(v_name, '') = '' then continue; end if;
    -- unit is a first guess from the name ("יח", "יחידה", "יחידות" → unit, otherwise kg); admin can switch it in settings
    v_unit := case when v_name ~ '(^|[^א-ת])(יח|יח׳|יח''|יחידה|יחידות)([^א-ת]|$)' then 'unit' else 'kg' end;
    update public.products set
           unit = case when name ~ '^[A-Za-z0-9._/-]+$' and name <> v_name then v_unit else unit end,
           name = v_name, sku = nullif(i ->> 'sku', ''), list_price = (i ->> 'price')::numeric,
           active = coalesce((i ->> 'active')::boolean, true)
     where morning_item_id = i ->> 'morning_item_id';
    if found then v_updated := v_updated + 1;
    else
      insert into public.products (name, unit, catalog, morning_item_id, sku, list_price, active)
      values (v_name, v_unit, 'business', i ->> 'morning_item_id', nullif(i ->> 'sku', ''), (i ->> 'price')::numeric, coalesce((i ->> 'active')::boolean, true));
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
