# BastaPack build guideline — approved v1

Approved by Omer on 27/10/2026. Living copy: https://claude.ai/artifact/2KBQU3V8jqHAq6Ge6QFi69. Update that doc and this file together.

Later decisions:
- 15/11/2026: no Vercel. Hosting is a static front end plus Supabase; see CLAUDE.md.

## Decisions

| # | Topic | Decision |
| --- | --- | --- |
| 1 | Language | Hebrew, right-to-left |
| 2 | Devices | Shared tablet at the packing station; phones also work |
| 3 | Logins | One shared employee username/password plus a separate admin login. Personal logins later |
| 4 | Order mailbox | Gmail the shop's order mailbox, read-only access. Orders come from `noreply@click-eat.co.il` |
| 5 | Working days | Mon–Fri: deliveries and pickups. Sunday: self-pickup only. Saturday: closed. Admin adds holidays |
| 6 | WhatsApp order with no day | The assistant always asks |
| 7 | Per-unit items | Per-kg items need a weight; per-unit items need a confirmed quantity |
| 8 | WhatsApp access | Owner only (the owner's number). The owner adds or removes numbers through WhatsApp, each confirmed with YES |
| 9 | Business prices | Saved price per client per product, editable, kept until changed. No saved price → the assistant asks and saves it. Price changes by WhatsApp are read back old → new and need YES |
| 10 | FIRE | Creates a delivery note (תעודת משלוח) in morning |
| 11 | morning keys | Stored in Supabase secrets only, never in chat or in the repo |
| 12 | Private final weight | Changes the charge. The app shows the price difference and exports it as CSV, with a column picker |
| 13 | Bulk actions | Both sections. Asks: Private, Business or both. Both → one CSV: Private, two empty lines, then Business |
| 14 | CSV columns | Picked in a popup; default: order #, day, type, client, business, phone, address, item, ordered, final, price difference, status, morning doc # |
| 15 | Employee edits | Weights plus add/remove products, in both sections |
| 16 | Volume | Under 25 deliveries a day on average, 30+ on peak days |
| 17 | Route | Starts at Mikve Israel 22. Ends back at the shop by default (admin setting). No time windows |

## Users

| Role | Can do |
| --- | --- |
| Employee | See and pack orders, enter and edit final weights, add/remove products on any order, mark Business orders as self-pickup, view the Deliver page |
| Admin | Everything an employee can, plus: add, edit and delete orders; bulk actions and CSV; price differences; FIRE; settings; activity log; Trash |

## Order statuses

New → Packed → Fired (Business only). Deleted orders go to Trash for 30 days. Orders from past days that are still unpacked appear in an "Overdue" section at the top.

## Order intake

### Private (ClickEat email)

- Subject: `הזמנה בבסטה דגים תל אביב | משלוח/לקחת | name | total | #order`.
- The body has fixed tables:
  - order number
  - weekday, date (dd.mm.yyyy) and time window
  - name, phone, type (משלוח = delivery, לקחת = pickup)
  - city, street, building, entrance, floor, apartment
  - item rows: quantity, name, line price, weight in kg, item note, option (e.g. `גוש/ליין או חתוך ?: חתוך`, `האם להסיר את העור?: פילה בלי עור`)
  - delivery fee, total, payment
- Quantity is a count whose meaning depends on the product: 100 g portions for sashimi/tartare, whole fillets for fillets. If a weight is given, the item is per-kg and price per kg = line price ÷ weight. No weight → per-unit item.
- The website order number is the app's order number. An email for an existing number updates that order, and the update is logged.
- The fixed format is parsed directly. AI is the fallback; anything uncertain goes to a "Needs review" list for admin, with the original email shown next to the draft.
- Card digits are never stored.

### Business (WhatsApp)

- Created by the WhatsApp assistant or manually by admin. The client is matched to morning using names and an "also known as" list.
- Numbered B-1001, B-1002, …

### Product catalog

- Each product has a name, a unit (kg / unit) and an active flag.
- Two separate lists (owner's decision, 23/11/2026):
  - **Private (website):** built from products seen in ClickEat orders. Admin can edit it.
  - **Business:** the item list in morning (פריטים), synced from Settings, with SKU (מק״ט). Business orders, client prices and the WhatsApp assistant use only this list. morning has no unit, so admin marks each item kg or unit.

## Employee interface

- The first screen shows two big buttons, PRIVATE and BUSINESS, plus a link to the Deliver page.
- Collapsible day sections. The next working day is on top and open. Headers read "Today · Tue 27/10", "Tomorrow · …", then the date only, with a count like "7 / 12 packed".
- Tapping an order expands it, and several orders can be open at once. Each item shows the ordered amount, a final weight/quantity box with a number pad, and a confirm button. Confirmed items turn green.
- In Private orders, the website quantity ("כמות באתר: 4") is shown large and bold above the estimated weight. Item notes and options are shown prominently.
- PACKED only works when every item is confirmed. Otherwise the app names the missing items. When an order is packed it collapses and the next unpacked order opens and scrolls into view. Packed orders stay in place, greyed, with a tick.
- Unpacking asks "Are you sure you want to unpack?"
- The Edit button lets staff change weights and add products (from the catalog) or remove them (with confirmation).
- **Private:** the order line shows number, name, phone, full address and time window. Pickups sit at the bottom of the day, in a different colour, labelled.
- **Business:** the order line shows number, business name, contact, phone, address, company name and registration number. A self-pickup switch moves the order to the pickup group and out of the route.

## Admin interface

- Admin sees the same screens plus:
  - edit order details
  - delete (to Trash)
  - "+ New order"
  - price difference per packed Private order
  - estimated/final totals on Business orders
- **FIRE** (packed Business orders only) creates the morning delivery note from final weights × saved client prices. If a price is missing, it is blocked and names the missing price. On success the order shows "Fired · morning #…" with a link and is locked.
- **Bulk:** select per order, per day or the whole section. Delete and CSV export (see decision 13).
- **Pages:**
  - Price differences (with CSV)
  - Needs review
  - Trash (restore within 30 days)
  - Activity log
  - Settings: passwords, working days and holidays, catalog, client aliases, client prices, WhatsApp allowed numbers, shop address, route end point

## Deliver page

- Shows the next delivery day by default, with a picker for other days. All non-pickup orders are included.
- Google Maps optimized route from Mikve Israel St. 22, Tel Aviv. It ends back at the shop by default (admin setting).
- Map plus numbered stops: name, address, phone, order number, item count, notes, packed status. Unpacked orders and unfound addresses are flagged.
- Stops can be dragged to reorder.
- Export as an A4 PDF in Hebrew, with Waze / Google Maps links or QR codes per stop.

## WhatsApp assistant

- Runs on its own dedicated number and answers allowed numbers only.
- Creates, edits and cancels Business orders from typed or forwarded messages, in Hebrew or English. It confirms in full, and asks instead of guessing (client, product, amount, day).
- Manages client prices: if a price is missing it asks; a change is read back old → new and needs YES.
- Answers questions about orders and the app. Reports failed background jobs. Diagnoses problems from logs.
- Changes the live app itself:
  1. reads back exactly what will change
  2. waits for YES
  3. runs automatic checks
  4. deploys
  5. "undo" restores the previous version
  Every change is logged with the original message.
- Cancel and delete need YES. FIRE needs confirmation in the chat. Only the owner can change allowed numbers. It cannot change logins.

## Phases

1. Core app
2. Email intake + Needs review
3. morning: client sync, aliases, prices, FIRE (sandbox first)
4. Deliver page
5. WhatsApp assistant
