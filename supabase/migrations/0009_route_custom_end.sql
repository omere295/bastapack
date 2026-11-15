-- The delivery route can end at a custom address (settings: route_end = 'custom', route_end_address).
alter table public.delivery_routes drop constraint if exists delivery_routes_end_mode_check;
alter table public.delivery_routes add constraint delivery_routes_end_mode_check check (end_mode in ('shop', 'last_stop', 'custom'));
alter table public.delivery_routes add column if not exists end_label text;
