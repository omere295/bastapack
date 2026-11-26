// Talks to Supabase over plain HTTPS (no extra libraries).
//   Auth:     /auth/v1/token
//   Tables:   /rest/v1/<table>
//   Actions:  /rest/v1/rpc/<function>   (rules live in supabase/migrations/0002_packing_functions.sql)
// Errors from the database come back in Hebrew and are shown to staff as-is.

const STORE_KEY = "bastapack-session";

const store = {
  get() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { return null; } },
  set(v) { try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* private mode */ } },
  clear() { try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } },
};

export function roleFromToken(token) {
  try {
    const payload = JSON.parse(decodeURIComponent(escape(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")))));
    return (payload.app_metadata && payload.app_metadata.role) || null;
  } catch { return null; }
}

export class SupabaseBackend {
  constructor({ url, key, logins }) {
    this.url = url; this.key = key; this.logins = logins;
    this.session = store.get();
  }

  get role() { return this.session ? roleFromToken(this.session.access_token) : null; }

  async signIn(username, password) {
    const u = String(username || "").trim().toLowerCase();
    const email = u.includes("@") ? u : this.logins[u];
    if (!email) throw new Error("שם משתמש או סיסמה שגויים");
    const res = await fetch(this.url + "/auth/v1/token?grant_type=password", {
      method: "POST", headers: { apikey: this.key, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(res.status === 400 ? "שם משתמש או סיסמה שגויים" : "אין חיבור לשרת. נסו שוב.");
    this._save(await res.json());
    if (!this.role) { this.signOut(); throw new Error("למשתמש הזה אין הרשאה לאפליקציה"); }
    return this.role;
  }

  async restore() {
    if (!this.session) return null;
    try { await this._fresh(); } catch { this.signOut(); return null; }
    return this.role;
  }

  signOut() { this.session = null; store.clear(); }

  _save(s) {
    this.session = { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Date.now() + (s.expires_in || 3600) * 1000 };
    store.set(this.session);
  }

  async _fresh() {
    if (!this.session) throw new Error("נא להתחבר מחדש");
    if (Date.now() < this.session.expires_at - 60000) return;
    const res = await fetch(this.url + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST", headers: { apikey: this.key, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: this.session.refresh_token }),
    });
    if (!res.ok) throw new Error("נא להתחבר מחדש");
    this._save(await res.json());
  }

  async _req(path, { method = "GET", body, prefer } = {}) {
    await this._fresh();
    const headers = { apikey: this.key, Authorization: "Bearer " + this.session.access_token, "Content-Type": "application/json" };
    if (prefer) headers.Prefer = prefer;
    let res;
    try { res = await fetch(this.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { throw new Error("אין חיבור לאינטרנט. השינוי לא נשמר."); }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error((data && (data.message || data.error_description)) || "שגיאה בשמירה");
    return data;
  }

  /** Everything the screens need. Admin also receives deleted orders (for Trash). */
  async loadAll(sinceDate) {
    const admin = this.role === "admin";
    const q = (t, s) => this._req("/rest/v1/" + t + s);
    const [orders, products, clients, holidays, settings, prices, review, memory] = await Promise.all([
      q("orders", "?select=*,order_items(*)&or=(delivery_date.gte." + sinceDate + ",status.eq.new)&order=delivery_date,number"),
      q("products", "?select=*&order=name"),
      this._all("/rest/v1/clients?select=*&order=business_name"),
      q("holidays", "?select=*&order=day"),
      q("settings", "?select=*"),
      admin ? q("client_prices", "?select=*") : Promise.resolve([]),
      admin ? q("email_inbox", "?select=id,gmail_id,received_at,subject,problem,parsed&status=eq.review&order=received_at.desc") : Promise.resolve([]),
      admin ? q("assistant_memory", "?select=id,fact,client_id,taught_by,created_at,clients(business_name)&deleted_at=is.null&order=created_at") : Promise.resolve([]),
    ]);
    return { orders, products, clients, holidays, settings, prices, review, memory };
  }

  /** Reads every row of a list, 1000 at a time (the server returns at most 1000 per request). */
  async _all(path) {
    const out = [];
    for (let from = 0; from < 50000; from += 1000) {
      const page = await this._req(path + "&limit=1000&offset=" + from);
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out;
  }

  /** Past orders of one kind between two dates (inclusive), newest day first. Read only. */
  loadHistory(kind, from, to) {
    return this._all("/rest/v1/orders?select=*,order_items(*)&deleted_at=is.null&kind=eq." + kind + "&delivery_date=gte." + from + "&delivery_date=lte." + to + "&order=delivery_date.desc,number");
  }

  loadLog() { return this._req("/rest/v1/activity_log?select=*&order=at.desc&limit=200"); }

  rpc(name, args) { return this._req("/rest/v1/rpc/" + name, { method: "POST", body: args }); }

  async loadRoute(day) {
    const rows = await this._req("/rest/v1/delivery_routes?day=eq." + day + "&select=*");
    return rows[0] || null;
  }

  /** Calls the route Edge Function: {action: "optimize" | "reorder", day, order?}. */
  route(body) { return this._fn("route", body, "חישוב המסלול נכשל"); }

  async _fn(name, body, fallback) {
    await this._fresh();
    let res;
    try {
      res = await fetch(this.url + "/functions/v1/" + name, {
        method: "POST", headers: { apikey: this.key, Authorization: "Bearer " + this.session.access_token, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    } catch { throw new Error("אין חיבור לאינטרנט"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || fallback);
    return data;
  }

  /** Calls the morning Edge Function: {action: "test" | "sync_clients" | "sync_items" | "fire" | "price_history", order_id?, client_id?}. */
  async morning(body) {
    await this._fresh();
    let res;
    try {
      res = await fetch(this.url + "/functions/v1/morning", {
        method: "POST", headers: { apikey: this.key, Authorization: "Bearer " + this.session.access_token, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    } catch { throw new Error("אין חיבור לאינטרנט"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "החיבור למורנינג נכשל");
    return data;
  }

  upsertClientPrices(rows) {
    return this._req("/rest/v1/client_prices?on_conflict=client_id,product_id", { method: "POST", body: rows, prefer: "resolution=merge-duplicates" });
  }
  addClient(row) { return this._req("/rest/v1/clients", { method: "POST", body: row, prefer: "return=representation" }); }
  forgetMemory(id) { return this._req("/rest/v1/assistant_memory?id=eq." + id, { method: "PATCH", body: { deleted_at: new Date().toISOString() } }); }
  updateClient(id, patch) { return this._req("/rest/v1/clients?id=eq." + id, { method: "PATCH", body: patch }); }
  addProduct(row) { return this._req("/rest/v1/products", { method: "POST", body: row }); }
  updateProduct(id, patch) { return this._req("/rest/v1/products?id=eq." + id, { method: "PATCH", body: patch }); }
  addHoliday(day, note) { return this._req("/rest/v1/holidays", { method: "POST", body: { day, note } }); }
  removeHoliday(day) { return this._req("/rest/v1/holidays?day=eq." + day, { method: "DELETE" }); }
  setSetting(key, value) {
    return this._req("/rest/v1/settings?on_conflict=key", { method: "POST", body: { key, value }, prefer: "resolution=merge-duplicates" });
  }
}
