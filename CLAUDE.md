# BastaPack — instructions for Claude

BastaPack is the internal orders app for **Basta Dagim** (בסטה דגים, legal name דגים בלבונטין בע"מ), a fish shop at Mikve Israel St. 22, Tel Aviv. Staff use it to collect, pack, invoice and deliver online orders.

The owner (Omer) has **no coding background**. Explain things in plain language, never ask him to run commands, and never ask him to paste passwords or API keys into a chat.

## Source of truth

- `docs/build-guideline.md` is the approved build prompt (v1, 27/10/2026). Follow it. If a request conflicts with it, say so and update the guideline first.
- `design/phase1-preview.html` is the approved clickable preview. The real app keeps its look, wording and flows unless the owner asks otherwise.

## Stack

- **Front end:** static web app (Vite + React + TypeScript), Hebrew, right-to-left, tablet-first. It is hosted as static files.
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
- **Before pushing:** run the type check, tests and build. Never push red.
- **Changes requested through the WhatsApp assistant:** read back exactly what will change, wait for the owner's YES, pass checks, deploy, and keep the previous version so "undo" can restore it.

## Phases

1. Core app: logins, both sections, packing flow, edit/delete, Trash, bulk + CSV, price differences
2. Email intake (ClickEat emails from `noreply@click-eat.co.il` to the shop's order mailbox)
3. morning: client sync, aliases, client prices, FIRE
4. Deliver page: Google Maps route from Mikve Israel 22, PDF
5. WhatsApp assistant

## Supabase project

- Project `bastapack`, ref `hpfxgqsgshglaiwrtogb`, organization "BastaDagim", region eu-central-1 (Frankfurt).
- Migrations applied: `0001_core_schema` (15/11/2026).
