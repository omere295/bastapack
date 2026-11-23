-- Automatic morning sync (owner's request, 23/11/2026):
--   products (items) every hour, 05:00–20:00 Israel time; business clients twice a day.
-- pg_cron calls the `morning` Edge Function through pg_net. The call carries the public anon key (it gets the
-- request past the gateway, nothing more) and a random cron key kept in Supabase Vault; the function asks the
-- database whether the key is right (check_cron_key) and then allows only the two sync actions.
-- Each run writes its time and result to settings (morning_items_synced / morning_clients_synced) for the Settings page.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'morning_cron_key', 'Lets pg_cron run the morning sync')
where not exists (select 1 from vault.secrets where name = 'morning_cron_key');

create or replace function public.check_cron_key(p_key text) returns boolean
language sql security definer set search_path = '' as $$
  select coalesce(p_key, '') <> '' and exists (select 1 from vault.decrypted_secrets where name = 'morning_cron_key' and decrypted_secret = p_key);
$$;
revoke all on function public.check_cron_key(text) from public, anon, authenticated;
grant execute on function public.check_cron_key(text) to service_role;

create or replace function public.morning_cron(p_action text) returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://hpfxgqsgshglaiwrtogb.supabase.co/functions/v1/morning',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwZnhncXNnc2hnbGFpd3J0b2diIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ3NTU5MzcsImV4cCI6MjExMDMzMTkzN30.1jKPzkeS7VOvWCu1wxL6TItyi0CT8alxdhtuqCTXi6E',
      'x-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'morning_cron_key')),
    body := jsonb_build_object('action', p_action),
    timeout_milliseconds := 120000);
$$;
revoke all on function public.morning_cron(text) from public, anon, authenticated;

-- pg_cron runs in UTC. 03:00–18:00 UTC is 05:00–20:00 in winter and 06:00–21:00 in summer.
select cron.schedule('morning-sync-items', '0 3-18 * * *', $$select public.morning_cron('sync_items')$$);
select cron.schedule('morning-sync-clients', '15 4,12 * * *', $$select public.morning_cron('sync_clients')$$);
