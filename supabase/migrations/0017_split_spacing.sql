-- Order rows from a split message sit 1 microsecond apart (0016 used 1 millisecond), so they always come before
-- a message that arrived right after the original.
-- replaces a message by one row per order, right after it in time (before anything sent later)
create or replace function public.wa_split(p_id text, p_parts jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare m public.wa_messages; i int := 0; part text;
begin
  select * into m from public.wa_messages where id = p_id;
  if not found then return 0; end if;
  for part in select value from jsonb_array_elements_text(p_parts) loop
    i := i + 1;
    insert into public.wa_messages (id, phone, direction, body, created_at)
    values (p_id || '#' || i, m.phone, 'in', part, m.created_at + make_interval(secs => i / 1000000.0))
    on conflict (id) do nothing;
  end loop;
  update public.wa_messages set hidden = true, handled_at = now() where id = p_id;
  return i;
end $$;

