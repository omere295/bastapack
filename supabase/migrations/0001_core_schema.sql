-- BastaPack core schema (Phase 1).
-- Roles come from the Supabase Auth user's app_metadata.role: 'employee' or 'admin'.
-- Employees change orders only through the functions in 0002 (packing, weights, items, pickup).
-- Admin may also edit rows directly. Background jobs use the service role, which bypasses RLS.


-- ---------- helpers ----------
create or replace function public.app_role() returns text
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')
$$;

create or replace function public.is_admin() returns boolean
language sql stable set search_path = '' as $$ select public.app_role() = 'admin' $$;

create or replace function public.is_staff() returns boolean
language sql stable set search_path = '' as $$ select public.app_role() in ('employee', 'admin') $$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$ begin new.updated_at = now(); return new; end $$;

-- ---------- catalog ----------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  unit text not null check (unit in ('kg', 'unit')),
  site_price numeric(10,2),            -- website price per kg / per unit, if known
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- business clients (mirror of morning) ----------
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  morning_id text unique,              -- client id in morning; null for clients not yet synced
  business_name text not null,
  contact_name text,
  legal_name text,
  company_number text,                 -- ח.פ. / ע.מ.
  phone text,
  address jsonb not null default '{}'::jsonb,   -- {city, street, building, entrance, floor, apt, notes}
  aliases text[] not null default '{}',         -- "also known as" names used by the WhatsApp assistant
  active boolean not null default true,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger clients_touch before update on public.clients for each row execute function public.touch_updated_at();

create table public.client_prices (
  client_id uuid not null references public.clients(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  price numeric(10,2) not null check (price > 0),   -- ₪ per kg or per unit, before VAT
  updated_at timestamptz not null default now(),
  updated_by text not null default 'admin',
  primary key (client_id, product_id)
);

-- ---------- orders ----------
create sequence public.business_order_seq start 1001;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('private', 'business')),
  number text not null unique,                 -- website number for private; 'B-1001' for business; 'M-…' for manual private
  delivery_date date not null,
  time_window text,
  pickup boolean not null default false,
  -- private customer
  customer_name text,
  phone text,
  address jsonb not null default '{}'::jsonb,
  delivery_fee numeric(10,2) not null default 0,
  -- business client
  client_id uuid references public.clients(id),
  -- lifecycle
  status text not null default 'new' check (status in ('new', 'packed', 'fired')),
  packed_at timestamptz,
  fired_at timestamptz,
  morning_doc_id text,
  morning_doc_number text,
  morning_doc_url text,
  deleted_at timestamptz,
  -- origin
  source text not null check (source in ('email', 'whatsapp', 'manual')),
  source_ref text,                             -- e.g. Gmail message id
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_has_client check (kind <> 'business' or client_id is not null),
  constraint private_has_customer check (kind <> 'private' or (customer_name is not null and phone is not null)),
  constraint delivery_needs_weekday check (pickup or extract(isodow from delivery_date) between 1 and 5),
  constraint fired_is_business check (status <> 'fired' or kind = 'business')
);
create index orders_open_by_day on public.orders (kind, delivery_date) where deleted_at is null;
create trigger orders_touch before update on public.orders for each row execute function public.touch_updated_at();

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id),
  name text not null,                          -- as ordered (kept even if the catalog changes)
  unit text not null check (unit in ('kg', 'unit')),
  ordered_count numeric(10,3),                 -- website quantity (portions / fillets / units)
  ordered_kg numeric(10,3),                    -- estimated weight for per-kg items
  line_price numeric(10,2),                    -- private: what the customer paid for this line
  option text not null default '',             -- e.g. 'חתוך', 'פילה בלי עור'
  note text not null default '',               -- customer's item note
  final_amount numeric(10,3),                  -- packed kg or count
  confirmed boolean not null default false,
  added_during_packing boolean not null default false,
  removed_at timestamptz,                      -- removed items stay for the price-difference record
  position int not null default 0,
  created_at timestamptz not null default now(),
  constraint final_positive check (final_amount is null or final_amount >= 0),
  constraint confirmed_has_final check (not confirmed or final_amount is not null)
);
create index order_items_by_order on public.order_items (order_id, position);

-- ---------- activity log ----------
create table public.activity_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null check (actor in ('employee', 'admin', 'whatsapp', 'system')),
  action text not null,                        -- e.g. 'packed', 'unpacked', 'weight_changed', 'item_added', 'deleted', 'fired'
  order_id uuid references public.orders(id) on delete set null,
  order_number text,
  details jsonb not null default '{}'::jsonb
);
create index activity_log_at on public.activity_log (at desc);

-- ---------- settings ----------
create table public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.settings (key, value) values
  ('shop_address', '"מקווה ישראל 22, תל אביב"'),
  ('route_end', '"shop"'),                    -- 'shop' or 'last_stop'
  ('timezone', '"Asia/Jerusalem"');

create table public.holidays (
  day date primary key,
  note text not null default ''
);

create table public.whatsapp_allowed (
  phone text primary key,                      -- E.164, e.g. +9725XXXXXXXX
  name text not null default '',
  is_owner boolean not null default false,
  added_at timestamptz not null default now()
);
-- The owner's number is added directly in the database, not here (this code is public).

-- ---------- row-level security ----------
alter table public.products enable row level security;
alter table public.clients enable row level security;
alter table public.client_prices enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.activity_log enable row level security;
alter table public.settings enable row level security;
alter table public.holidays enable row level security;
alter table public.whatsapp_allowed enable row level security;

-- staff read
create policy products_read on public.products for select to authenticated using (public.is_staff());
create policy clients_read on public.clients for select to authenticated using (public.is_staff());
create policy holidays_read on public.holidays for select to authenticated using (public.is_staff());
create policy settings_read on public.settings for select to authenticated using (public.is_staff());
create policy orders_read on public.orders for select to authenticated
  using (public.is_staff() and (deleted_at is null or public.is_admin()));
create policy items_read on public.order_items for select to authenticated
  using (public.is_staff() and exists (select 1 from public.orders o where o.id = order_id and (o.deleted_at is null or public.is_admin())));

-- admin-only read
create policy prices_read on public.client_prices for select to authenticated using (public.is_admin());
create policy log_read on public.activity_log for select to authenticated using (public.is_admin());
create policy wa_read on public.whatsapp_allowed for select to authenticated using (public.is_admin());

-- admin direct writes (employees go through functions)
create policy products_admin on public.products for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy clients_admin on public.clients for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy prices_admin on public.client_prices for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy holidays_admin on public.holidays for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy settings_admin on public.settings for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy orders_admin_insert on public.orders for insert to authenticated with check (public.is_admin());
create policy orders_admin_update on public.orders for update to authenticated
  using (public.is_admin() and status <> 'fired') with check (public.is_admin());
create policy items_admin on public.order_items for all to authenticated
  using (public.is_admin() and exists (select 1 from public.orders o where o.id = order_id and o.status <> 'fired'))
  with check (public.is_admin() and exists (select 1 from public.orders o where o.id = order_id and o.status <> 'fired'));
-- no delete policy on orders: deleting = setting deleted_at; whatsapp_allowed changes go through the assistant (service role)
