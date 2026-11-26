-- Lets the whatsapp Edge Function (service role only) call the morning function's price_history action (26/11/2026).
-- The key is the same Vault secret pg_cron uses (0014); it never leaves the server.
create or replace function public.internal_key() returns text
language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'morning_cron_key';
$$;
revoke all on function public.internal_key() from public, anon, authenticated;
grant execute on function public.internal_key() to service_role;
