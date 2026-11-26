-- Emily takes any number of messages, each with any number of orders (owner's request, 26/11/2026).
--   * Messages from one person are answered one at a time, oldest first (wa_claim / wa_release / wa_next).
--     A lock with a 3-minute lease makes sure only one request works for a person at a time.
--   * A message with several orders is split into one hidden-original + one row per order ("<id>#1", "#2", ...),
--     each answered as its own message. hidden rows are kept but left out of the conversation history.
--   * tries stops a message that keeps failing after 3 attempts.
--   * Every minute, pg_cron re-queues anything waiting longer than a minute (if a request was cut off).

alter table public.wa_messages
  add column hidden boolean not null default false,
  add column tries int not null default 0,
  add column started_at timestamptz;  -- when Emily started answering it: orders the conversation (reply follows its message)

create table public.wa_locks (phone text primary key, until timestamptz not null);
alter table public.wa_locks enable row level security;

create or replace function public.wa_claim(p_phone text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.wa_locks (phone, until) values (p_phone, now() + interval '3 minutes')
  on conflict (phone) do update set until = excluded.until where public.wa_locks.until < now();
  return found;
end $$;

create or replace function public.wa_release(p_phone text) returns void
language sql security definer set search_path = '' as $$
  delete from public.wa_locks where phone = p_phone;
$$;

-- oldest message still waiting for an answer; counts the attempt
create or replace function public.wa_next(p_phone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.wa_messages;
begin
  select * into m from public.wa_messages
   where phone = p_phone and direction = 'in' and not hidden and handled_at is null
   order by created_at, id limit 1 for update;
  if not found then return null; end if;
  update public.wa_messages set tries = tries + 1, started_at = now() where id = m.id;
  return jsonb_build_object('id', m.id, 'body', m.body, 'created_at', m.created_at, 'tries', m.tries + 1);
end $$;

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
    values (p_id || '#' || i, m.phone, 'in', part, m.created_at + make_interval(secs => i / 1000.0))
    on conflict (id) do nothing;
  end loop;
  update public.wa_messages set hidden = true, handled_at = now() where id = p_id;
  return i;
end $$;

revoke all on function public.wa_claim(text), public.wa_release(text), public.wa_next(text), public.wa_split(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.wa_claim(text), public.wa_release(text), public.wa_next(text), public.wa_split(text, jsonb)
  to service_role;

select cron.schedule('whatsapp-requeue', '* * * * *', $$
  select public.wa_enqueue(q.id) from (
    select distinct on (phone) id, phone from public.wa_messages
     where direction = 'in' and not hidden and handled_at is null
       and created_at < now() - interval '1 minute' and created_at > now() - interval '1 hour'
     order by phone, created_at) q
  where not exists (select 1 from public.wa_locks l where l.phone = q.phone and l.until > now())
$$);
