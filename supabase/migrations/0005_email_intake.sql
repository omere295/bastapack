-- Private orders from ClickEat emails.
-- The email-intake Edge Function reads each email (supabase/functions/_shared/clickeat.js) and calls
-- ingest_email() with the result. Each Gmail message is handled once. Anything doubtful goes to the
-- admin's "Needs review" list rather than being guessed.

create table public.email_inbox (
  id uuid primary key default gen_random_uuid(),
  gmail_id text not null unique,
  received_at timestamptz,
  subject text,
  status text not null check (status in ('imported', 'updated', 'review', 'handled', 'ignored')),
  problem text,
  parsed jsonb,
  html text,                       -- payment table removed before storing
  order_id uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now()
);
create index email_inbox_review on public.email_inbox (status) where status = 'review';
alter table public.email_inbox enable row level security;
create policy inbox_read on public.email_inbox for select to authenticated using (public.is_admin());
create policy inbox_admin on public.email_inbox for update to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.ingest_email(p_gmail_id text, p_subject text, p_received timestamptz, p_parsed jsonb, p_problem text, p_html text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ex public.email_inbox; o public.orders; v_order uuid; i jsonb; pr public.products;
  v_unit text; v_kg numeric; v_cnt numeric; v_price numeric; pos int := 0; v_status text := 'imported'; v_problem text := p_problem;
begin
  select * into ex from public.email_inbox where gmail_id = p_gmail_id;
  if found then return jsonb_build_object('status', ex.status, 'order_id', ex.order_id, 'duplicate', true); end if;

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
          select * into pr from public.products where name = i ->> 'name';
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
revoke all on function public.ingest_email(text, text, timestamptz, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.ingest_email(text, text, timestamptz, jsonb, text, text) to service_role;

-- "Handled" button on the Needs review list
create or replace function public.mark_email_handled(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  update public.email_inbox set status = 'handled' where id = p_id and status = 'review';
end $$;
revoke all on function public.mark_email_handled(uuid) from public, anon;
grant execute on function public.mark_email_handled(uuid) to authenticated;
