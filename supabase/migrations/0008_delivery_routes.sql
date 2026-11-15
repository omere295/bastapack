-- Delivery routes (Deliver page). The `route` Edge Function finds each address with Google Geocoding,
-- orders the stops with Google Routes, and saves the result here per delivery day.
-- Staff can reorder stops; the function then recalculates the drive times.

create table public.geocode_cache (
  query text primary key,            -- the address text sent to Google
  ok boolean not null,
  lat double precision,
  lng double precision,
  formatted text,
  updated_at timestamptz not null default now()
);
alter table public.geocode_cache enable row level security;   -- service role only

create table public.delivery_routes (
  day date primary key,
  stop_ids uuid[] not null default '{}',     -- orders in driving order
  legs jsonb not null default '[]',          -- [{seconds, meters}] from the shop to stop 1, 1→2, …, and back if the route returns
  points jsonb not null default '{}',        -- order id → {lat, lng, formatted}
  unfound uuid[] not null default '{}',      -- orders whose address Google could not find
  end_mode text not null default 'shop' check (end_mode in ('shop', 'last_stop')),
  total_seconds int,
  total_meters int,
  optimized boolean not null default false,  -- false after a manual reorder
  computed_at timestamptz not null default now()
);
alter table public.delivery_routes enable row level security;
create policy routes_read on public.delivery_routes for select to authenticated using (public.is_staff());
