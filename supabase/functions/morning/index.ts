// morning (Green Invoice) connection. Called by the app with the admin's login.
//   {action: "test"}                 → checks the API key works (reads one client, changes nothing)
//   {action: "sync_clients"}         → copies business clients from morning into the app
//   {action: "sync_items"}           → copies morning's item list (פריטים) into the app as the business product catalog
//   {action: "fire", order_id}       → creates a delivery note (תעודת משלוח, type 200) for a packed Business order
//   {action: "price_history", client_id} → the last price the client paid for each business product (past year's documents)
// The two sync actions also run on a schedule (pg_cron, migration 0014). Those calls, and Emily's price_history calls,
// carry x-cron-key, checked in the database.
// Secrets (Supabase → Edge Functions → Secrets): MORNING_API_KEY_ID, MORNING_API_KEY_SECRET.
// Optional MORNING_ENV=sandbox to use morning's practice environment.
// API: token from api.morning.co/idp/v1/oauth/token (OAuth client credentials, valid 1 hour);
//      everything else on api.greeninvoice.co.il/api/v1.

const SANDBOX = Deno.env.get("MORNING_ENV") === "sandbox";
const TOKEN_URL = SANDBOX ? "https://api.sandbox.morning.dev/idp/v1/oauth/token" : "https://api.morning.co/idp/v1/oauth/token";
const API = SANDBOX ? "https://sandbox.d.greeninvoice.co.il/api/v1" : "https://api.greeninvoice.co.il/api/v1";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
class UserError extends Error {}

function roleOf(req: Request): string | null {
  try {
    const t = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
    const p = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return p?.app_metadata?.role ?? null;
  } catch { return null; }
}

// ---------- Supabase (service role) ----------
async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(SB_URL + path, { ...init, headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", ...(init.headers || {}) } });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new UserError((data && data.message) || "שגיאת מסד נתונים");
  return data;
}
const rpc = (name: string, args: unknown) => db("/rest/v1/rpc/" + name, { method: "POST", body: JSON.stringify(args) });

// ---------- morning ----------
let token: { value: string; exp: number } | null = null;
async function morningToken() {
  if (token && Date.now() < token.exp - 60_000) return token.value;
  const id = Deno.env.get("MORNING_API_KEY_ID"), secret = Deno.env.get("MORNING_API_KEY_SECRET");
  if (!id || !secret) throw new UserError("מפתח ה-API של מורנינג עוד לא הוגדר ב-Supabase");
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials", client_id: id, client_secret: secret }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.accessToken) {
    const e = data.error || res.status;
    throw new UserError(e === "unauthorized_client" ? "המנוי במורנינג לא כולל גישת API" : e === "invalid_client" ? "מפתח ה-API של מורנינג שגוי" : e === "invalid_grant" ? "מפתח ה-API של מורנינג פג תוקף או בוטל" : "מורנינג לא אישר את החיבור (" + e + ")");
  }
  token = { value: data.accessToken, exp: data.expiresAt ? data.expiresAt * 1000 : Date.now() + 3_600_000 };
  return token.value;
}
async function morning(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const res = await fetch(API + path, { method, headers: { Authorization: "Bearer " + (await morningToken()), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new UserError("מורנינג החזיר שגיאה: " + ((data && (data.errorMessage || data.message)) || res.status));
  return data;
}

// ---------- actions ----------
/** Remembers when a sync last ran and what it did (shown in Settings). */
const stamp = (key: string, result: unknown) =>
  db("/rest/v1/settings?on_conflict=key", { method: "POST", body: JSON.stringify({ key, value: { at: new Date().toISOString(), ...(result as object) } }), headers: { Prefer: "resolution=merge-duplicates" } }).catch(() => {});
async function syncClients() {
  const all: any[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await morning("/clients/search", { page, pageSize: 100 });
    const items = r?.items || [];
    all.push(...items);
    if (items.length < 100 || (r.pages && page >= r.pages)) break;
  }
  const rows = all.filter((c) => c && c.id && c.name).map((c) => ({
    morning_id: String(c.id), name: String(c.name).trim(), company_number: c.taxId || "", contact_name: c.contactPerson || "",
    phone: c.phone || c.mobile || "", active: c.active !== false, address: c.address || c.city ? { street: c.address || "", city: c.city || "" } : {},
  }));
  const res = await rpc("sync_morning_clients", { p_clients: rows });
  await stamp("morning_clients_synced", { ...res, total: rows.length });
  return { ...res, total: rows.length };
}

async function syncItems() {
  const all: any[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await morning("/items/search", { page, pageSize: 100 });
    const items = r?.items || [];
    all.push(...items);
    if (items.length < 100 || (r.pages && page >= r.pages)) break;
  }
  // In this morning account the item "name" holds the catalogue number (e.g. "012") and the real product name is in
  // "description". When the name looks like a code, use it as the SKU and take the name from the description.
  const isCode = (t: string) => /^[A-Za-z0-9\-_./]{1,15}$/.test(t) && /\d/.test(t);
  const rows = all.filter((it) => it && it.id && (it.name || it.description)).map((it) => {
    const name = String(it.name ?? "").trim(), desc = String(it.description ?? "").split("\n")[0].trim();
    const code = isCode(name) && !!desc;
    return {
      morning_item_id: String(it.id), name: code ? desc : name || desc, sku: code ? name : String(it.sku ?? it.catalogNum ?? "").trim(),
      price: typeof it.price === "number" ? it.price : null, active: it.active !== false,
    };
  });
  if (!rows.length) throw new UserError("לא נמצאו פריטים במורנינג. הוסיפו פריטים במורנינג (הגדרות → פריטים) ונסו שוב.");
  const res = await rpc("sync_morning_items", { p_items: rows });
  await stamp("morning_items_synced", { ...res, total: rows.length });
  return { ...res, total: rows.length };
}

/** The last price a client actually paid for each business product, from his morning documents of the past year
 *  (delivery notes, invoices, invoice-receipts; cancelled documents and minus lines are skipped). Prices are before VAT. */
async function priceHistory(clientId: string) {
  const [c] = await db("/rest/v1/clients?id=eq." + encodeURIComponent(clientId) + "&select=id,morning_id,business_name");
  if (!c) throw new UserError("לקוח לא נמצא");
  if (!c.morning_id) throw new UserError("הלקוח לא מקושר למורנינג");
  const products = await db("/rest/v1/products?catalog=eq.business&select=id,name,unit,sku,morning_item_id,list_price");
  const byItem = new Map(products.filter((p: any) => p.morning_item_id).map((p: any) => [p.morning_item_id, p]));
  const bySku = new Map(products.filter((p: any) => p.sku).map((p: any) => [p.sku, p]));
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(d);
  const from = day(new Date(Date.now() - 365 * 86400_000)), to = day(new Date());
  const found = new Map<string, any>();
  let documents = 0;
  for (let page = 1; page <= 5; page++) {
    const r = await morning("/documents/search", { page, pageSize: 100, clientId: c.morning_id, fromDate: from, toDate: to, sort: "documentDate" });
    const docs = r?.items || [];
    for (const d of docs) {
      if (d?.client?.id && d.client.id !== c.morning_id) continue;   // only this client's documents
      if (![200, 300, 305, 320].includes(d?.type) || [3, 4].includes(d?.status)) continue;
      if (!d.documentDate || d.documentDate < from) continue;
      documents++;
      for (const l of d.income || []) {
        const p: any = byItem.get(l.itemId) || bySku.get(String(l.catalogNum ?? ""));
        if (!p || !(Number(l.price) > 0)) continue;
        const net = l.vatType === 1 ? Number(l.price) / (1 + Number(l.vatRate ?? d.vatRate ?? 0.18)) : Number(l.price);
        const prev = found.get(p.id);
        if (prev && prev.date >= d.documentDate) continue;
        found.set(p.id, { product_id: p.id, name: p.name, unit: p.unit, price: Math.round(net * 100) / 100, date: d.documentDate, doc: String(d.number ?? ""),
          regular: p.list_price != null ? Number(p.list_price) : null });
      }
    }
    if (docs.length < 100 || (r.pages && page >= r.pages)) break;
  }
  return { client: c.business_name, documents, prices: [...found.values()].sort((a, b) => a.name.localeCompare(b.name, "he")) };
}

async function fire(orderId: string) {
  await rpc("claim_fire", { p_order: orderId });
  try {
    const [o] = await db("/rest/v1/orders?id=eq." + orderId + "&select=*,order_items(*,products(morning_item_id,sku,list_price)),clients(*)");
    const c = o.clients;
    if (!c?.morning_id) throw new UserError("הלקוח לא מקושר למורנינג. הריצו סנכרון לקוחות בהגדרות.");
    const prices = await db("/rest/v1/client_prices?client_id=eq." + c.id + "&select=product_id,price");
    const priceOf: Record<string, number> = Object.fromEntries(prices.map((p: any) => [p.product_id, Number(p.price)]));
    const items = o.order_items.filter((i: any) => !i.removed_at).sort((a: any, b: any) => a.position - b.position);
    // no price saved for this client: the item's regular price from morning
    for (const i of items) if (priceOf[i.product_id] == null && i.products?.list_price != null) priceOf[i.product_id] = Number(i.products.list_price);
    const missing = items.filter((i: any) => priceOf[i.product_id] == null).map((i: any) => i.name);
    if (missing.length) throw new UserError("חסר מחיר (ללקוח וגם במורנינג) עבור: " + missing.join(", "));
    if (items.some((i: any) => !i.confirmed)) throw new UserError("יש פריטים בלי משקל סופי");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
    const doc = await morning("/documents", {
      type: 200, lang: "he", currency: "ILS", vatType: 0, date: today,
      description: "הזמנה " + o.number, remarks: "הזמנה " + o.number + " · " + (o.pickup ? "איסוף עצמי" : "משלוח") + " · " + o.delivery_date,
      client: { id: c.morning_id },
      income: items.map((i: any) => ({
        description: i.name + (i.unit === "kg" ? " (ק״ג)" : ""), quantity: Number(i.final_amount), price: priceOf[i.product_id], currency: "ILS", vatType: 0,
        // linked to the morning item when the product came from morning, so morning's item reports include it
        ...(i.products?.morning_item_id ? { itemId: i.products.morning_item_id } : {}), ...(i.products?.sku ? { catalogNum: i.products.sku } : {}),
      })),
    });
    let url = doc?.url?.he || doc?.url?.origin || doc?.files?.downloadLinks?.he || null;
    if (!url && doc?.id) { try { const l = await morning("/documents/" + doc.id + "/download/links"); url = l?.he || l?.origin || null; } catch { /* link is optional */ } }
    await rpc("finish_fire", { p_order: orderId, p_doc_id: String(doc.id), p_doc_number: String(doc.number ?? ""), p_doc_url: url });
    return { number: doc.number, url };
  } catch (e) {
    await rpc("release_fire", { p_order: orderId }).catch(() => {});
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "בקשה לא תקינה" }, 400); }
  const cron = !!req.headers.get("x-cron-key") && ["sync_items", "sync_clients", "price_history"].includes(body?.action)
    && (await rpc("check_cron_key", { p_key: req.headers.get("x-cron-key") }).catch(() => false)) === true;
  if (!cron && roleOf(req) !== "admin") return json({ error: "פעולה למנהל בלבד" }, 403);
  try {
    if (body.action === "test") { await morning("/clients/search", { page: 1, pageSize: 1 }); return json({ ok: true, sandbox: SANDBOX }); }
    if (body.action === "sync_clients") return json(await syncClients());
    if (body.action === "sync_items") return json(await syncItems());
    if (body.action === "price_history" && body.client_id) return json(await priceHistory(String(body.client_id)));
    if (body.action === "fire" && body.order_id) return json(await fire(String(body.order_id)));
    return json({ error: "פעולה לא מוכרת" }, 400);
  } catch (e) {
    return json({ error: e instanceof UserError ? e.message : "שגיאה: " + (e as Error).message }, e instanceof UserError ? 400 : 500);
  }
});
