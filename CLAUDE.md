# BastaPack — instructions for Claude

BastaPack is the internal orders app for **Basta Dagim** (בסטה דגים, legal name דגים בלבונטין בע"מ), a fish shop at Mikve Israel St. 22, Tel Aviv. Staff use it to collect, pack, invoice and deliver online orders.

The owner (Omer) has **no coding background**. Explain things in plain language, never ask him to run commands, and never ask him to paste passwords or API keys into a chat.

## Source of truth

- `docs/build-guideline.md` is the approved build prompt (v1, 27/10/2026). Follow it. If a request conflicts with it, say so and update the guideline first.
- `design/phase1-preview.html` is the approved clickable preview. The real app keeps its look, wording and flows unless the owner asks otherwise.

## Stack

- **Front end:** `web/` — plain modern JavaScript modules, no build step and no npm packages (the build workspace cannot reach npm or CDNs). `web/app.js` holds the screens; `web/lib/` holds tested logic (`days.js`, `money.js`, `csv.js`) and the data layer (`backend.js` talks to Supabase over HTTPS; `demo-backend.js` is an in-memory copy with the same rules, used by `?demo` and the tests). Hosted with GitHub Pages from `web/` (see `.github/workflows/checks.yml`).
- **Back end:** Supabase (project `bastapack`, region Central EU / Frankfurt): Postgres database, Auth, Edge Functions and scheduled jobs (pg_cron + pg_net).
- **No Vercel.** Its free plan does not allow commercial use (decided 15/11/2026).
- Schema changes go in `supabase/migrations/` as numbered SQL files. Never edit a migration that has already been applied; add a new one.

## Rules

- **Secrets never go in the repo:** morning API key, Gmail tokens, WhatsApp tokens, AI keys, Supabase service-role key. They live in Supabase secrets only. The public Supabase URL and publishable (anon) key may be in front-end code; every table is protected by row-level security.
- **Card digits from order emails are never stored.**
- **Every write to orders is logged** in `activity_log` (who: `employee` / `admin` / `whatsapp` / `system`).
- **Deletes are soft:** `deleted_at`, restorable for 30 days. A fired order (`status = 'fired'`) cannot be deleted or have weights edited.
- **Dates and days use Asia/Jerusalem.** Mon–Fri: deliveries and pickups. Sunday: self-pickup only. Saturday: closed. Admin can add holidays.
- **Money is in ₪ with 2 decimals.**
  - Private price difference = (final − ordered) × price per unit, where price per kg = line price ÷ ordered kg. The delivery fee is excluded.
  - Business prices come from `client_prices` (per client per product).
- **morning (Green Invoice):** follow the current API docs (base URL `api.greeninvoice.co.il`, token body includes `grant_type: client_credentials`, changed June 2026). FIRE creates a delivery note (תעודת משלוח). Test against the morning sandbox before production.
- **Before pushing:** `node --test tests/*.test.mjs` and `python3 tests/ui.spec.py <local URL>` (serve `web/` with `python3 -m http.server`). GitHub runs the same checks on every push; never push red. When the rules in `0002_packing_functions.sql` change, change `demo-backend.js` the same way.
- **Security definer functions:** the Supabase advisor warns that staff can call the order functions in 0002. That is intended: each one checks the caller's role itself.
- **Changes requested through the WhatsApp assistant:** read back exactly what will change, wait for the owner's YES, pass checks, deploy, and keep the previous version so "undo" can restore it.

## Phases

1. Core app: logins, both sections, packing flow, edit/delete, Trash, bulk + CSV, price differences
2. Email intake (ClickEat emails from `noreply@click-eat.co.il` to the shop's order mailbox)
3. morning: client sync, aliases, client prices, FIRE
4. Deliver page: Google Maps route from Mikve Israel 22, PDF
5. WhatsApp assistant

## Supabase project

- Project `bastapack`, ref `hpfxgqsgshglaiwrtogb`, organization "BastaDagim", region eu-central-1 (Frankfurt).
- Migrations applied: 0001–0013 (23/11/2026; 0013: Emily can order pieces of a weighed product and add per-item notes; 0014: pg_cron runs the morning sync, items hourly 05–20, clients twice a day, through public.morning_cron with a Vault cron key; 0015: each WhatsApp message is answered in its own request, queued by wa_enqueue through pg_net, because background work after the webhook reply was cut off after about a minute). Products have two catalogs (0011): `private` (website, built from ClickEat emails) and `business` (morning items, `morning` function action `sync_items`; in this morning account the item name field holds the SKU and the description holds the product name); a trigger keeps business orders on business products and private orders on website products, and `demo-backend.js` follows the same rule. Routes put central Tel Aviv first (stops within settings route_center_km of the shop, default 4), then the rest. Route end: shop, last stop or custom address (settings route_end_address). Edge Function `route` deployed (secret GOOGLE_MAPS_API_KEY; Geocoding + Routes computeRoutes, results in delivery_routes). Edge Function `morning` deployed (secrets MORNING_API_KEY_ID, MORNING_API_KEY_SECRET; production unless MORNING_ENV=sandbox). Edge Function `email-intake` deployed (needs secret INTAKE_SECRET; Gmail side is `integrations/gmail-to-bastapack.gs`, a Google Apps Script running every minute in the shop's Gmail). Edge Function `whatsapp` deployed (verify_jwt off; webhook for Meta WhatsApp Cloud API; logic in `_shared/assistant.js`; secrets WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, ANTHROPIC_API_KEY, optional GITHUB_TOKEN; currently on Meta's test number until business verification; permanent System User token "Emily"; the assistant is named Emily / אמילי). Edge Function `wa-setup` is a one-click link (`?key=<verify token>&waba=<WhatsApp account id>`) that subscribes the WhatsApp account to the app; run it again after moving to the real number. The owner's WhatsApp number is stored only in the database (this repo is public). Products seeded from real ClickEat orders.
- Logins: `staff@bastadagim.co.il` (employee, username `basta`) and `admin@bastadagim.co.il` (admin, username `admin`); roles are set by the trigger in 0004.
