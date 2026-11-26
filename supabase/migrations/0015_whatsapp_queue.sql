-- Emily answers each message in a request of its own (see functions/whatsapp/index.ts).
-- The webhook saves the message and calls wa_enqueue(); pg_net then calls the whatsapp function with the internal
-- key (the Vault secret from 0014, checked by check_cron_key) and the message id. handled_at marks answered messages.

alter table public.wa_messages add column handled_at timestamptz;
update public.wa_messages set handled_at = created_at where direction = 'in';

create or replace function public.wa_enqueue(p_id text) returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://hpfxgqsgshglaiwrtogb.supabase.co/functions/v1/whatsapp?forceFunctionRegion=eu-central-1',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-internal-key', (select decrypted_secret from vault.decrypted_secrets where name = 'morning_cron_key')),
    body := jsonb_build_object('process', p_id),
    timeout_milliseconds := 150000);
$$;
revoke all on function public.wa_enqueue(text) from public, anon, authenticated;
grant execute on function public.wa_enqueue(text) to service_role;
