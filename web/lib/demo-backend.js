// An in-memory copy of the database used for the demo (?demo in the address) and for automated tests.
// It follows the same rules as the real database functions in supabase/migrations/0002_packing_functions.sql.
// Customers and restaurants here are invented.

import { todayIL, nextDeliveryDay, addDays, weekday } from "./days.js";

const uid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const clone = (v) => JSON.parse(JSON.stringify(v));
const fail = (msg) => { throw new Error(msg); };

const PRODUCTS = [
  ["סשימי טונה", "kg", 420], ["סשימי טורו טונה", "kg", 600], ["סשימי סלמון נורווגי", "kg", 220], ["סשימי יילו טייל המאצ׳י", "kg", 460],
  ["טרטר טונה טרי", "kg", 420], ["טרטר סלמון נורווגי", "kg", 220], ["טרטר יילו טייל המאצ׳י", "kg", 460], ["קרפצ׳יו פלמידה לבנה", "kg", 460],
  ["פילה סלמון נורווגי לפי משקל", "kg", 155], ["פילה סלמון נורווגי פרוס טרי", "kg", 155], ["פילה דניס טרי", "kg", 236.36],
  ["פילה לברק טרי", "kg", 236.36], ["פילה לוקוס טרי", "kg", 380], ["גיוזה עוף", "unit", 30], ["צנצנת רוטב פונזו בסטה דגים", "unit", 20],
].map(([name, unit, site_price]) => ({ id: "p-" + uid(), name, unit, site_price, active: true, catalog: "private" }));
// Business products come from morning's item list (the real app syncs them; see 0011_business_products.sql).
const BIZ_PRODUCTS = [
  ["פילה סלמון נורווגי", "kg", "101", 120], ["סשימי טונה אדומה", "kg", "102", 340], ["סשימי סלמון", "kg", "103", 175],
  ["פילה לברק", "kg", "104", 190], ["פילה דניס", "kg", "012", 180], ["רוטב פונזו בסטה", "unit", "201", 18],
].map(([name, unit, sku, list_price]) => ({ id: "b-" + uid(), name, unit, sku, list_price, active: true, catalog: "business", morning_item_id: "demo-item-" + sku }));

export function demoSeed(today = todayIL()) {
  const P = (n) => PRODUCTS.find((p) => p.name === n);
  const BP = (n) => BIZ_PRODUCTS.find((p) => p.name === n);
  const D0 = nextDeliveryDay(today, { inclusive: true }), D1 = nextDeliveryDay(D0), D2 = nextDeliveryDay(D1);
  let SUN = addDays(today, 1); while (weekday(SUN) !== 0) SUN = addDays(SUN, 1);
  let OVER = addDays(D0, -1); while (weekday(OVER) === 0 || weekday(OVER) === 6) OVER = addDays(OVER, -1);
  const clients = [
    { id: "c1", business_name: "מסעדת הנמל", contact_name: "יוסי אלון", legal_name: "הנמל הצפוני בע״מ", company_number: "515234871", phone: "052-7781203", address: { city: "תל אביב-יפו", street: "נמל תל אביב, האנגר", building: "12" }, aliases: ["הנמל"] },
    { id: "c2", business_name: "ביסטרו אלנבי", contact_name: "מאיה רז", legal_name: "א.ר. ביסטרו בע״מ", company_number: "516098432", phone: "054-3320918", address: { city: "תל אביב-יפו", street: "אלנבי", building: "64" }, aliases: [] },
    { id: "c3", business_name: "סושי צפון", contact_name: "אורי קדמי", legal_name: "צפון אוכל יפני בע״מ", company_number: "514877610", phone: "050-9912447", address: { city: "רמת גן", street: "ז׳בוטינסקי", building: "21" }, aliases: [] },
  ].map((c) => ({ morning_id: "demo-" + c.id, active: true, price_mode: "special", ...c }));
  const orders = [];
  const items = (oid, list) => list.map(([name, count, price, kg, option, note], i) => {
    const p = P(name);
    return { id: "i-" + uid(), order_id: oid, product_id: p.id, name, unit: p.unit, ordered_count: count, ordered_kg: p.unit === "kg" ? (kg ?? null) : null,
      line_price: price, option: option || "", note: note || "", final_amount: null, confirmed: false, added_during_packing: false, removed_at: null, position: i + 1 };
  });
  const priv = (num, date, name, phone, pickup, address, list, win) => {
    const id = "o-" + num;
    orders.push({ id, kind: "private", number: String(num), delivery_date: date, time_window: win || (pickup ? "10:00-17:00" : "09:00-16:00"), pickup,
      customer_name: name, phone, address: pickup ? {} : address, delivery_fee: pickup ? 0 : 30, client_id: null, status: "new", packed_at: null,
      deleted_at: null, morning_doc_number: null, source: "email", order_items: items(id, list) });
  };
  const biz = (num, date, cid, list, pickup) => {
    const id = "o-B" + num;
    orders.push({ id, kind: "business", number: "B-" + num, delivery_date: date, time_window: null, pickup: !!pickup, customer_name: null, phone: null,
      address: {}, delivery_fee: 0, client_id: cid, status: "new", packed_at: null, deleted_at: null, morning_doc_number: null, source: "whatsapp",
      order_items: list.map(([name, amt, pcs, note], i) => { const p = BP(name); return { id: "i-" + uid(), order_id: id, product_id: p.id, name, unit: p.unit,
        ordered_count: p.unit === "unit" || pcs ? amt : null, ordered_kg: p.unit === "kg" && !pcs ? amt : null, line_price: null, option: "", note: note || "", final_amount: null,
        confirmed: false, added_during_packing: false, removed_at: null, position: i + 1 }; }) });
  };
  const cut = "חתוך";
  priv(976, OVER, "עומר דביר", "054-6612980", false, { city: "תל אביב-יפו", street: "פלורנטין", building: "18", floor: "2", apt: "4" }, [["סשימי סלמון נורווגי", 3, 66, 0.3, cut]]);
  priv(981, D0, "נועה ברק", "052-6380112", false, { city: "תל אביב-יפו", street: "שלמה המלך", building: "41", floor: "3", apt: "9" }, [["סשימי טונה", 4, 168, 0.4, cut, "אם אפשר לחתוך ממש דק, תודה"], ["טרטר סלמון נורווגי", 4, 88, 0.4, cut], ["גיוזה עוף", 2, 60]]);
  priv(982, D0, "איתי שרון", "050-2219044", false, { city: "רמת גן", street: "ביאליק", building: "12", entrance: "ב", floor: "6", apt: "23" }, [["פילה דניס טרי", 3, 156, 0.66], ["פילה סלמון נורווגי לפי משקל", 2, 155, 1, "פילה בלי עור", "מהחלק העבה בבקשה"]]);
  priv(983, D0, "מיכל אדלר", "053-8804082", true, null, [["טרטר טונה טרי", 12, 504, 1.2, cut], ["טרטר יילו טייל המאצ׳י", 8, 368, 0.8, cut]]);
  priv(984, D0, "Daniel Cohen", "058-5320081", false, { city: "Tel Aviv-Yafo", street: "Dizengoff Street", building: "180", floor: "5" }, [["סשימי טורו טונה", 2, 120, 0.2, cut], ["סשימי סלמון נורווגי", 3, 66, 0.3, cut]]);
  priv(986, D1, "גיל אבני", "052-9917735", false, { city: "גבעתיים", street: "כצנלסון", building: "50", floor: "1", apt: "2" }, [["קרפצ׳יו פלמידה לבנה", 1, 46, 0.1, cut], ["פילה לברק טרי", 1, 52, 0.22, "פילה בלי עור"]]);
  priv(987, D1, "שירה לוי", "054-2345443", true, null, [["סשימי טונה", 2, 84, 0.2, "גוש/ליין", "גוש מלבני להכנת טאטקי"], ["צנצנת רוטב פונזו בסטה דגים", 1, 20]]);
  priv(989, D2, "ליאת פרץ", "052-8585951", false, { city: "ירקונה", street: "הדקל", building: "9" }, [["פילה סלמון נורווגי לפי משקל", 2, 155, 1, "פילה עם עור"]]);
  priv(991, SUN, "הדס נחום", "054-7771230", true, null, [["פילה דניס טרי", 2, 104, 0.44], ["גיוזה עוף", 1, 30]]);
  biz(1001, D0, "c1", [["פילה סלמון נורווגי", 6], ["סשימי טונה אדומה", 2]]);
  biz(1002, D0, "c2", [["פילה לברק", 3], ["רוטב פונזו בסטה", 6]], true);
  biz(1003, D1, "c3", [["סשימי טונה אדומה", 3], ["סשימי סלמון", 4], ["פילה דניס", 2, true, "לפלט"]]);
  // one order already packed so every state shows
  const o = orders.find((x) => x.number === "984");
  o.order_items[0].final_amount = 0.21; o.order_items[1].final_amount = 0.32;
  o.order_items.forEach((i) => (i.confirmed = true)); o.status = "packed"; o.packed_at = new Date().toISOString();
  // history: an order delivered a few days ago (packed), so the history view has something to show
  biz(1000, addDays(today, -3), "c1", [["פילה סלמון נורווגי", 4]]);
  const past = orders.find((x) => x.number === "B-1000");
  past.order_items[0].final_amount = 4.125; past.order_items[0].confirmed = true; past.status = "packed";
  const prices = [
    ["c1", "פילה סלמון נורווגי", 128], ["c1", "סשימי טונה אדומה", 360], ["c2", "פילה לברק", 205],
    ["c3", "סשימי טונה אדומה", 365], ["c3", "סשימי סלמון", 185],
  ].map(([client_id, n, price]) => ({ client_id, product_id: BP(n).id, price }));
  const review = [{ id: "r1", gmail_id: "demo", received_at: new Date().toISOString(), status: "review", subject: "הזמנה בבסטה דגים תל אביב | משלוח | רון כץ | 342 ₪ | #993",
    problem: "סכום הפריטים (312.00) לא תואם לסה״כ (342)",
    parsed: { number: "993", delivery_date: D1, time_window: "09:00-16:00", pickup: false, customer_name: "רון כץ", phone: "0521112233",
      address: { city: "תל אביב-יפו", street: "בן יהודה", building: "120" }, delivery_fee: 30, total: 342,
      items: [{ name: "פילה סלמון נורווגי לפי משקל", count: 2, price: 155, kg: 1, note: "", option: "" }, { name: "פילה לברק טרי", count: 1, price: 52, kg: 0.22, note: "", option: "" }] } }];
  const memory = [{ id: "mem-1", fact: "למסעדת הנמל תמיד לנקות ולפלט את הדג", client_id: "c1", taught_by: "+972500000001", created_at: "2026-11-20T09:00:00Z", deleted_at: null }];
  return { memory, review, orders, products: clone([...PRODUCTS, ...BIZ_PRODUCTS]), clients, prices, holidays: [], settings: [{ key: "route_end", value: "shop" }, { key: "shop_address", value: "מקווה ישראל 22, תל אביב" }], log: [], seq: { b: 1004, m: 501 } };
}

export class DemoBackend {
  constructor(seed = demoSeed()) { this.db = seed; this.role = null; }

  async signIn(username, password) {
    const u = String(username || "").trim().toLowerCase();
    if (u === "admin" && password === "9999") this.role = "admin";
    else if ((u === "basta" || u === "staff") && password === "1234") this.role = "employee";
    else throw new Error("שם משתמש או סיסמה שגויים");
    return this.role;
  }
  async restore() { return this.role; }
  signOut() { this.role = null; }

  async loadAll() {
    const admin = this.role === "admin";
    return clone({
      orders: this.db.orders.filter((o) => admin || !o.deleted_at).map((o) => ({ ...o, order_items: o.order_items })),
      products: this.db.products, clients: this.db.clients, holidays: this.db.holidays, settings: this.db.settings,
      prices: admin ? this.db.prices : [],
      review: admin ? this.db.review.filter((r) => r.status === "review") : [],
      memory: admin ? this.db.memory.filter((m) => !m.deleted_at).map((m) => ({ ...m, clients: m.client_id ? { business_name: this.db.clients.find((c) => c.id === m.client_id)?.business_name } : null })) : [],
    });
  }
  async loadHistory(kind, from, to) {
    return clone(this.db.orders.filter((o) => !o.deleted_at && o.kind === kind && o.delivery_date >= from && o.delivery_date <= to)
      .sort((a, b) => (a.delivery_date < b.delivery_date ? 1 : -1)));
  }
  async loadLog() { if (this.role !== "admin") fail("פעולה למנהל בלבד"); return clone(this.db.log); }

  _log(action, o, details = {}) {
    this.db.log.unshift({ id: this.db.log.length + 1, at: new Date().toISOString(), actor: this.role === "admin" ? "admin" : "employee", action, order_id: o.id, order_number: o.number, details });
  }
  _editable(id) {
    if (!this.role) fail("אין הרשאה");
    const o = this.db.orders.find((x) => x.id === id);
    if (!o || o.deleted_at) fail("ההזמנה לא נמצאה");
    if (o.status === "fired") fail("ההזמנה הופקה במורנינג ולכן נעולה");
    return o;
  }
  _item(id) {
    for (const o of this.db.orders) { const it = o.order_items.find((i) => i.id === id && !i.removed_at); if (it) return [this._editable(o.id), it]; }
    fail("הפריט לא נמצא");
  }
  _admin() { if (this.role !== "admin") fail("פעולה למנהל בלבד"); }

  async rpc(name, a) {
    switch (name) {
      case "set_item_final": {
        const [o, it] = this._item(a.p_item); const v = a.p_amount;
        if (v == null || v < 0) fail("כמות לא תקינה");
        if (it.unit === "kg" && (v <= 0 || v > 200)) fail("משקל בין 0.01 ל-200 ק״ג");
        if (it.unit === "unit" && !Number.isInteger(v)) fail("כמות צריכה להיות מספר שלם");
        if (it.confirmed && it.final_amount !== v) this._log("weight_changed", o, { item: it.name, from: it.final_amount, to: v });
        it.final_amount = v; it.confirmed = true; return null;
      }
      case "pack_order": {
        const o = this._editable(a.p_order); if (o.status === "packed") return null;
        const live = o.order_items.filter((i) => !i.removed_at);
        if (!live.length) fail("אין פריטים בהזמנה");
        const missing = live.filter((i) => !i.confirmed).map((i) => i.name);
        if (missing.length) fail("חסר אישור משקל ל: " + missing.join(", "));
        o.status = "packed"; o.packed_at = new Date().toISOString(); this._log("packed", o); return null;
      }
      case "unpack_order": {
        const o = this._editable(a.p_order); if (o.status !== "packed") return null;
        o.status = "new"; o.packed_at = null; this._log("unpacked", o); return null;
      }
      case "add_item": {
        const o = this._editable(a.p_order); const p = this.db.products.find((x) => x.id === a.p_product && x.active);
        if (!p) fail("המוצר לא נמצא");
        this._catalogOk(o.kind, p);
        if (!(a.p_amount > 0) || (p.unit === "unit" && !Number.isInteger(a.p_amount))) fail("כמות לא תקינה");
        const id = "i-" + uid();
        o.order_items.push({ id, order_id: o.id, product_id: p.id, name: p.name, unit: p.unit, ordered_count: p.unit === "unit" ? a.p_amount : null,
          ordered_kg: p.unit === "kg" ? a.p_amount : null, line_price: null, option: "", note: "", final_amount: null, confirmed: false,
          added_during_packing: o.kind === "private", removed_at: null, position: o.order_items.length + 1 });
        if (o.status === "packed") { o.status = "new"; o.packed_at = null; }
        this._log("item_added", o, { item: p.name, amount: a.p_amount }); return id;
      }
      case "remove_item": {
        const [o, it] = this._item(a.p_item); it.removed_at = new Date().toISOString();
        if (o.status === "packed" && !o.order_items.some((i) => !i.removed_at)) { o.status = "new"; o.packed_at = null; }
        this._log("item_removed", o, { item: it.name }); return null;
      }
      case "set_pickup": {
        const o = this._editable(a.p_order);
        if (o.kind !== "business" && this.role !== "admin") fail("אין הרשאה");
        if (!a.p_pickup && (weekday(o.delivery_date) === 0 || weekday(o.delivery_date) === 6)) fail("ביום ראשון יש איסוף עצמי בלבד");
        o.pickup = a.p_pickup; this._log(a.p_pickup ? "pickup_on" : "pickup_off", o); return null;
      }
      case "delete_orders": {
        this._admin(); let n = 0;
        for (const o of this.db.orders) if (a.p_ids.includes(o.id) && !o.deleted_at && o.status !== "fired") { o.deleted_at = new Date().toISOString(); this._log("deleted", o); n++; }
        return n;
      }
      case "mark_email_handled": {
        this._admin(); const r = this.db.review.find((x) => x.id === a.p_id); if (r) r.status = "handled"; return null;
      }
      case "restore_order": {
        this._admin(); const o = this.db.orders.find((x) => x.id === a.p_order);
        if (o && o.deleted_at) { o.deleted_at = null; this._log("restored", o); } return null;
      }
      case "update_order": {
        this._admin(); const o = this._editable(a.p_order);
        for (const k of ["delivery_date", "time_window", "pickup", "customer_name", "phone", "address", "client_id", "notes"]) if (k in a.p) o[k] = a.p[k];
        this._log("edited", o, a.p); return null;
      }
      case "create_manual_order": {
        this._admin(); const p = a.p;
        if (!p.items || !p.items.length) fail("הוסיפו לפחות מוצר אחד");
        const number = p.kind === "business" ? "B-" + this.db.seq.b++ : "M-" + this.db.seq.m++;
        const id = "o-" + uid();
        const o = { id, kind: p.kind, number, delivery_date: p.delivery_date, time_window: p.time_window || null, pickup: !!p.pickup,
          customer_name: p.customer_name || null, phone: p.phone || null, address: p.address || {}, delivery_fee: p.delivery_fee || 0,
          client_id: p.client_id || null, status: "new", packed_at: null, deleted_at: null, morning_doc_number: null, source: "manual", order_items: [] };
        p.items.forEach((i, idx) => {
          const pr = this.db.products.find((x) => x.id === i.product_id); if (!pr) fail("מוצר לא נמצא");
          this._catalogOk(p.kind, pr);
          o.order_items.push({ id: "i-" + uid(), order_id: id, product_id: pr.id, name: pr.name, unit: pr.unit,
            ordered_count: pr.unit === "unit" ? i.amount : null, ordered_kg: pr.unit === "kg" ? i.amount : null,
            line_price: p.kind === "private" ? Math.round(i.amount * pr.site_price * 100) / 100 : null, option: "", note: "",
            final_amount: null, confirmed: false, added_during_packing: false, removed_at: null, position: idx + 1 });
          if (p.kind === "business" && i.price != null) this._setPrice(p.client_id, pr.id, i.price);
        });
        this.db.orders.push(o); this._log("created", o); return id;
      }
    }
    fail("פעולה לא מוכרת");
  }
  async loadRoute(day) { return (this.db.routes || {})[day] || null; }
  async route(body) {
    const stops = this.db.orders.filter((o) => !o.deleted_at && !o.pickup && o.delivery_date === body.day);
    let ids = stops.map((o) => o.id);
    if (body.action === "reorder") { const pos = new Map(body.order.map((id, i) => [id, i])); ids.sort((a, b) => (pos.get(a) ?? 1e9) - (pos.get(b) ?? 1e9)); }
    else ids.reverse(); // the demo "optimizer" just picks a different order
    const legs = ids.map((_, i) => ({ seconds: 420 + i * 60, meters: 2500 + i * 300 })).concat([{ seconds: 600, meters: 3000 }]);
    const r = { day: body.day, stop_ids: ids, legs, points: Object.fromEntries(ids.map((id, i) => [id, { lat: 32.06 + i / 100, lng: 34.77 }])), unfound: [],
      end_mode: (this.db.settings.find((x) => x.key === "route_end") || {}).value || "shop",
      end_label: (this.db.settings.find((x) => x.key === "route_end_address") || {}).value || null, optimized: body.action === "optimize", computed_at: new Date().toISOString(),
      total_seconds: legs.reduce((s, l) => s + l.seconds, 0), total_meters: legs.reduce((s, l) => s + l.meters, 0) };
    (this.db.routes ||= {})[body.day] = r;
    return JSON.parse(JSON.stringify(r));
  }
  async morning(body) {
    this._admin();
    if (body.action === "test") return { ok: true, demo: true };
    if (body.action === "sync_clients") return { added: 0, updated: this.db.clients.length, total: this.db.clients.length };
    if (body.action === "price_history") {
      // pretend morning's documents show the client paid the saved price, or ₪5 over the regular price
      const mine = Object.fromEntries(this.db.prices.filter((x) => x.client_id === body.client_id).map((x) => [x.product_id, x.price]));
      const prices = this.db.products.filter((p) => p.catalog === "business" && p.list_price != null).slice(0, 3)
        .map((p) => ({ product_id: p.id, name: p.name, unit: p.unit, price: mine[p.id] ?? p.list_price + 5, regular: p.list_price, date: "2026-11-20", doc: "27001" }));
      return clone({ client: this.db.clients.find((c) => c.id === body.client_id)?.business_name, documents: 12, prices });
    }
    if (body.action === "sync_items") { const n = this.db.products.filter((p) => p.catalog === "business").length; return { added: 0, updated: n, deactivated: 0, total: n }; }
    if (body.action === "fire") {
      const o = this.db.orders.find((x) => x.id === body.order_id);
      if (!o || o.kind !== "business") fail("ההזמנה לא נמצאה");
      if (o.status === "fired") fail("ההזמנה כבר הופקה");
      if (o.status !== "packed") fail("יש לארוז את ההזמנה לפני ההפקה");
      // same rule as the morning function: the client's price, otherwise the item's regular price
      const prices = this.db.prices.filter((p) => p.client_id === o.client_id).map((p) => p.product_id)
        .concat(this.db.products.filter((p) => p.list_price != null).map((p) => p.id));
      const missing = o.order_items.filter((i) => !i.removed_at && !prices.includes(i.product_id)).map((i) => i.name);
      if (missing.length) fail("חסר מחיר (ללקוח וגם במורנינג) עבור: " + missing.join(", "));
      o.status = "fired"; o.morning_doc_number = String(40000 + this.db.log.length); o.morning_doc_url = null;
      this._log("fired", o, { doc: o.morning_doc_number });
      return { number: o.morning_doc_number, url: null };
    }
    fail("פעולה לא מוכרת");
  }
  _setPrice(client_id, product_id, price) {
    const ex = this.db.prices.find((x) => x.client_id === client_id && x.product_id === product_id);
    if (ex) ex.price = price; else {
      this.db.prices.push({ client_id, product_id, price });
      const c = this.db.clients.find((x) => x.id === client_id);
      if (c && !c.price_mode) c.price_mode = "special"; // same as the client_prices_mark_special trigger (0018)
    }
  }
  /** Removes one thing Emily was taught (soft, like the real table). */
  async forgetMemory(id) { this._admin(); const m = this.db.memory.find((x) => x.id === id); if (m) m.deleted_at = new Date().toISOString(); }
  async upsertClientPrices(rows) { this._admin(); rows.forEach((r) => this._setPrice(r.client_id, r.product_id, r.price)); }
  async addClient(row) { this._admin(); const c = { id: "c-" + uid(), aliases: [], active: true, address: {}, ...row }; this.db.clients.push(c); return [c]; }
  async updateClient(id, patch) { this._admin(); Object.assign(this.db.clients.find((c) => c.id === id), patch); }
  async addProduct(row) { this._admin(); if (this.db.products.some((p) => p.catalog === "private" && p.name === row.name)) fail("מוצר בשם הזה כבר קיים"); this.db.products.push({ id: "p-" + uid(), active: true, catalog: "private", ...row }); }
  /** Same rule as the order_items_catalog trigger (0011): business orders use morning items, private orders website products. */
  _catalogOk(kind, p) {
    if (kind === "business" && p.catalog !== "business") fail("בהזמנה עסקית אפשר לבחור רק מוצרים ממורנינג");
    if (kind === "private" && p.catalog !== "private") fail("בהזמנה פרטית אפשר לבחור רק מוצרים מהאתר");
  }
  async updateProduct(id, patch) { this._admin(); Object.assign(this.db.products.find((p) => p.id === id), patch); }
  async addHoliday(day, note) { this._admin(); if (!this.db.holidays.some((h) => h.day === day)) this.db.holidays.push({ day, note }); }
  async removeHoliday(day) { this._admin(); this.db.holidays = this.db.holidays.filter((h) => h.day !== day); }
  async setSetting(key, value) { this._admin(); const s = this.db.settings.find((x) => x.key === key); if (s) s.value = value; else this.db.settings.push({ key, value }); }
}
