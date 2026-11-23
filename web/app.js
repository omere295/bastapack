// BastaPack — the packing app. Hebrew, right-to-left, tablet first.
// Screens follow the approved preview in design/phase1-preview.html.
// Data comes from Supabase (lib/backend.js); add ?demo to the address to use invented sample data instead.

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, LOGINS, REFRESH_MS } from "./config.js";
import { SupabaseBackend } from "./lib/backend.js";
import { DemoBackend } from "./lib/demo-backend.js";
import { todayIL, addDays, weekday, isDeliveryDay, isOpenDay, nextDeliveryDay, dayParts, dayLabel, upcomingOpenDays, TZ } from "./lib/days.js";
import { orderedAmount, privateUnitPrice, privateItemDiff, privateOrderDiff, businessTotal, formatShekel as nis, parseAmount, round2 } from "./lib/money.js";
import { buildCsv } from "./lib/csv.js";

const DEMO = new URLSearchParams(location.search).has("demo");
const B = DEMO ? new DemoBackend() : new SupabaseBackend({ url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY, logins: LOGINS });
window.__bastapack = { backend: B }; // used by automated tests

/* ---------- state ---------- */
let D = null; // loaded data
const ui = {
  role: null, screen: "login", loginErr: "", busy: false, offline: false, loaded: false,
  open: new Set(), dayOpen: {}, editing: new Set(), drafts: {}, errs: {}, notes: {},
  selectMode: false, selected: new Set(), modal: null, toast: null,
  flash: null, opening: null, shake: null, scrollTo: null, focusId: null, adding: {}, deliverDay: null, log: null, routes: {}, routeBusy: false,
};
const isAdmin = () => ui.role === "admin";
const TODAY = () => todayIL();

/* ---------- helpers ---------- */
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, dp) => (Math.round(n * 1000) / 1000).toLocaleString("he-IL", { minimumFractionDigits: dp ?? 0, maximumFractionDigits: dp ?? 3 });
const kg = (n) => fmt(Number(n), Number(n) < 10 ? 2 : 1);
const fullAddr = (a) => !a ? "" : [a.street && (a.street + (a.building ? " " + a.building : "")), a.entrance && ("כניסה " + a.entrance), a.floor && a.floor !== "0" && ("קומה " + a.floor), a.apt && ("דירה " + a.apt), a.city].filter(Boolean).join(", ");
const reduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const holidays = () => (D ? D.holidays.map((h) => h.day) : []);
const setting = (k, dflt) => { const s = D && D.settings.find((x) => x.key === k); return s ? s.value : dflt; };

const live = () => D.orders.filter((o) => !o.deleted_at);
const byId = (id) => D.orders.find((o) => o.id === id);
const client = (id) => D.clientsById[id] || { business_name: "לקוח לא ידוע", address: {} };
const items = (o) => o.order_items.filter((i) => !i.removed_at).sort((a, b) => a.position - b.position);
const removed = (o) => o.order_items.filter((i) => i.removed_at);
const oName = (o) => (o.kind === "private" ? o.customer_name : client(o.client_id).business_name);
const isPacked = (o) => o.status !== "new";
const isFired = (o) => o.status === "fired";
const unitLbl = (it) => (it.unit === "kg" ? "ק״ג" : "יח׳");
const amtText = (it, v) => (it.unit === "kg" ? kg(v) + " ק״ג" : fmt(Number(v)) + " יח׳");
const orderDiff = (o) => (o.kind === "private" ? privateOrderDiff(o.order_items, D.productsById) : 0);
const itemDiff = (o, it) => (o.kind === "private" ? privateItemDiff(it, D.productsById[it.product_id]) : 0);
const unitPrice = (o, it) => (o.kind === "private" ? privateUnitPrice(it, D.productsById[it.product_id]) : (D.priceMap[o.client_id] || {})[it.product_id] ?? null);
/** Up to `limit` clients matching the search text (name, company, ח.פ., phone or nickname). Empty search: clients with a price list. */
function clientMatches(q, limit = 25) {
  const t = String(q || "").trim().toLowerCase();
  const list = D.clients.filter((c) => c.active !== false);
  if (!t) return list.filter((c) => D.priceMap[c.id]).slice(0, limit);
  return list.filter((c) => [c.business_name, c.legal_name, c.company_number, c.phone, ...(c.aliases || [])].some((x) => x && String(x).toLowerCase().includes(t))).slice(0, limit);
}
const bizTotal = (o) => businessTotal(o.order_items, D.priceMap[o.client_id] || {});

let toastTimer = null;
function toast(msg) { ui.toast = msg; clearTimeout(toastTimer); toastTimer = setTimeout(() => { ui.toast = null; render(); }, 3000); }

/* ---------- data ---------- */
function index(data) {
  data.productsById = Object.fromEntries(data.products.map((p) => [p.id, p]));
  data.clientsById = Object.fromEntries(data.clients.map((c) => [c.id, c]));
  data.priceMap = {};
  for (const r of data.prices) (data.priceMap[r.client_id] ||= {})[r.product_id] = Number(r.price);
  return data;
}
let loading = null;
async function reload() {
  if (loading) return loading;
  loading = (async () => {
    try {
      D = index(await B.loadAll(addDays(TODAY(), -35)));
      ui.offline = false; ui.loaded = true;
    } catch (e) {
      if (/להתחבר/.test(e.message)) { logout(); return; }
      ui.offline = true;
    } finally { loading = null; }
  })();
  return loading;
}
/** Runs an action, shows its error in Hebrew, reloads and re-renders. */
async function act(fn, { okToast, noteFor } = {}) {
  if (ui.busy) return false;
  ui.busy = true; render();
  let ok = true;
  try { await fn(); if (okToast) toast(okToast); }
  catch (e) { ok = false; if (noteFor) { ui.notes[noteFor] = { cls: "bad", text: e.message }; ui.open.add(noteFor); } else toast(e.message); }
  await reload();
  ui.busy = false; render();
  return ok;
}

/* ---------- sections ---------- */
function sortDay(list) {
  return list.slice().sort((a, b) => (a.pickup - b.pickup) || (a.delivery_date < b.delivery_date ? -1 : a.delivery_date > b.delivery_date ? 1 : 0) || String(a.number).localeCompare(String(b.number), "en", { numeric: true }));
}
function sectionGroups(kind) {
  const t = TODAY();
  const os = live().filter((o) => o.kind === kind && (o.delivery_date >= t || !isPacked(o)));
  const map = {};
  for (const o of os) { const k = o.delivery_date < t && !isPacked(o) ? "overdue" : o.delivery_date; (map[k] ||= []).push(o); }
  return Object.keys(map).sort((a, b) => (a === "overdue" ? -1 : b === "overdue" ? 1 : a < b ? -1 : 1)).map((k) => ({ key: k, orders: sortDay(map[k]) }));
}
function dayIsOpen(kind, key) {
  const k = kind + ":" + key;
  if (k in ui.dayOpen) return ui.dayOpen[k];
  if (key === "overdue") return true;
  const g = sectionGroups(kind).filter((x) => x.key !== "overdue");
  return g.length > 0 && g[0].key === key;
}
function nextUnpacked(o) {
  const g = sectionGroups(o.kind).find((x) => x.orders.some((y) => y.id === o.id));
  if (!g) return null;
  const i = g.orders.findIndex((x) => x.id === o.id);
  return g.orders.slice(i + 1).find((x) => !isPacked(x)) || g.orders.slice(0, i).find((x) => !isPacked(x)) || null;
}

/* ---------- packing actions ---------- */
async function confirmItem(oid, iid) {
  const o = byId(oid), it = o.order_items.find((x) => x.id === iid), key = oid + ":" + iid;
  const r = parseAmount(ui.drafts[key] ?? it.final_amount, it.unit);
  if (r.error) { ui.errs[key] = r.error; ui.focusId = "w-" + key; render(); return; }
  delete ui.errs[key];
  const ok = await act(() => B.rpc("set_item_final", { p_item: iid, p_amount: r.value }), { noteFor: oid });
  if (!ok) return;
  delete ui.drafts[key]; delete ui.notes[oid];
  const o2 = byId(oid); if (!o2) return;
  const nxt = items(o2).find((x) => !x.confirmed);
  if (nxt) ui.focusId = "w-" + oid + ":" + nxt.id;
  else if (!isPacked(o2)) ui.notes[oid] = { cls: "good", text: "כל המשקלים הוזנו. סמנו את ההזמנה כארוזה." };
  render();
}
async function tryPack(oid) {
  const o = byId(oid);
  if (isPacked(o)) {
    if (isFired(o)) { toast("הזמנה שהופקה במורנינג לא ניתנת לביטול אריזה"); return; }
    openConfirm({ title: "לבטל את האריזה?", body: "הזמנה " + o.number + " · " + oName(o) + " תחזור לרשימת ההזמנות שלא נארזו.", ok: "כן, לבטל אריזה", danger: true,
      run: () => act(() => B.rpc("unpack_order", { p_order: oid }), { okToast: "ההזמנה הוחזרה ללא ארוזה" }) });
    return;
  }
  const missing = items(o).filter((i) => !i.confirmed);
  if (missing.length) {
    ui.open.add(oid); ui.shake = oid;
    ui.notes[oid] = { cls: "bad", text: "חסר אישור משקל ל: " + missing.map((m) => m.name).join(", ") };
    ui.focusId = "w-" + oid + ":" + missing[0].id; render(); return;
  }
  const ok = await act(() => B.rpc("pack_order", { p_order: oid }), { noteFor: oid });
  if (!ok) return;
  ui.open.delete(oid); ui.editing.delete(oid); delete ui.notes[oid]; ui.flash = oid;
  const o2 = byId(oid); const n = o2 && nextUnpacked(o2);
  if (n) { ui.open.add(n.id); ui.opening = n.id; ui.scrollTo = n.id; }
  render();
}
async function addItem(oid) {
  const a = ui.adding[oid] || {}; const p = D.productsById[a.p];
  if (!p) { ui.notes[oid] = { cls: "bad", text: "בחרו מוצר להוספה" }; render(); return; }
  const r = parseAmount(a.a, p.unit);
  if (r.error || r.value <= 0) { ui.notes[oid] = { cls: "bad", text: "הזינו כמות תקינה" }; render(); return; }
  const wasPacked = isPacked(byId(oid));
  const ok = await act(() => B.rpc("add_item", { p_order: oid, p_product: p.id, p_amount: r.value }), { noteFor: oid });
  if (!ok) return;
  delete ui.adding[oid];
  ui.notes[oid] = wasPacked ? { cls: "info", text: "נוסף פריט, ולכן ההזמנה חזרה ללא ארוזה. אשרו את המשקל וסמנו שוב." } : undefined;
  if (!ui.notes[oid]) delete ui.notes[oid];
  const added = items(byId(oid)).slice(-1)[0];
  if (added) ui.focusId = "w-" + oid + ":" + added.id;
  render();
}

/* ---------- rendering ---------- */
const $app = document.getElementById("app");
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>';
const CHEV = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

function render() {
  const active = document.activeElement;
  const keepFocus = active && active.id && !ui.focusId ? active.id : null;
  const keepSel = keepFocus && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;
  let h = "";
  if (DEMO) h += '<div class="strip"><div class="wrap"><span>מצב הדגמה · נתונים בדויים · שינויים לא נשמרים</span></div></div>';
  if (ui.offline) h += '<div class="offline">אין חיבור לשרת. מנסה שוב…</div>';
  if (ui.screen === "login") h += renderLogin();
  else {
    h += renderHeader();
    h += '<main class="' + (ui.busy ? "" : "") + '"><div class="wrap">' + (ui.loaded ? renderScreen() : '<div class="loading">טוען הזמנות…</div>') + "</div></main>";
    if (ui.selectMode && isAdmin() && (ui.screen === "private" || ui.screen === "business")) h += renderBulk();
  }
  if (ui.modal) h += renderModal();
  if (ui.toast) h += '<div class="toast" role="status"><div>' + esc(ui.toast) + "</div></div>";
  $app.innerHTML = h;
  const fid = ui.focusId || keepFocus;
  if (fid) {
    const el = document.getElementById(fid);
    if (el) {
      el.focus({ preventScroll: !ui.focusId });
      try { if (ui.focusId && el.select) el.select(); else if (keepSel && el.setSelectionRange) el.setSelectionRange(keepSel[0], keepSel[1]); } catch { /* not a text input */ }
    }
  }
  ui.focusId = null;
  if (ui.scrollTo) { const el = document.getElementById("card-" + ui.scrollTo); if (el) setTimeout(() => el.scrollIntoView({ block: "start", behavior: reduced() ? "auto" : "smooth" }), 120); ui.scrollTo = null; }
  ui.flash = null; ui.opening = null; ui.shake = null;
}

function renderLogin() {
  return '<main><div class="wrap"><form class="login" id="loginForm" autocomplete="on">' +
    '<img class="login-logo" src="logo-white.png" alt="בסטה דגים"><p>הזמנות, אריזה ומשלוחים</p>' +
    '<div class="field"><label for="lu">שם משתמש</label><input id="lu" name="username" dir="ltr" autocomplete="username" autocapitalize="none" value="' + esc(ui.loginUser || "") + '" required></div>' +
    '<div class="field"><label for="lp">סיסמה</label><input id="lp" name="password" type="password" dir="ltr" autocomplete="current-password" required></div>' +
    (ui.loginErr ? '<div class="err">' + esc(ui.loginErr) + "</div>" : "") +
    '<button class="btn primary" type="submit"' + (ui.busy ? " disabled" : "") + ">" + (ui.busy ? "מתחבר…" : "כניסה") + "</button>" +
    (DEMO ? '<div class="hint"><b>כניסה להדגמה</b><span>עובדים: basta / 1234 · מנהל: admin / 9999</span></div>' : "") +
    "</form></div></main>";
}

const TITLES = { home: "", private: "פרטי", business: "עסקי", deliver: "משלוחים", diffs: "הפרשי מחיר", trash: "סל מחזור", log: "יומן פעולות", settings: "הגדרות", review: "לבדיקה" };
function renderHeader() {
  return '<header class="top"><div class="wrap">' +
    '<button class="brand" data-act="go:home" aria-label="בסטה דגים · מסך הבית"><img src="logo-white.png" alt="בסטה דגים"></button>' +
    '<div class="crumb">' + esc(TITLES[ui.screen] || "") + "</div>" +
    (ui.screen !== "home" ? '<button class="ghost" data-act="go:home">חזרה</button>' : "") +
    '<span class="role ' + (isAdmin() ? "admin" : "") + '">' + (isAdmin() ? "מנהל" : "עובד") + "</span>" +
    '<button class="ghost" data-act="logout">יציאה</button></div></header>';
}

function renderScreen() {
  switch (ui.screen) {
    case "home": return renderHome();
    case "private": case "business": return renderSection(ui.screen);
    case "deliver": return renderDeliver();
    case "diffs": return isAdmin() ? renderDiffs() : "";
    case "trash": return isAdmin() ? renderTrash() : "";
    case "log": return isAdmin() ? renderLog() : "";
    case "settings": return isAdmin() ? renderSettings() : "";
    case "review": return isAdmin() ? renderReview() : "";
  }
  return "";
}

function homeCount(kind) {
  const g = sectionGroups(kind).filter((x) => x.key !== "overdue")[0];
  if (!g) return "אין הזמנות פתוחות";
  return dayLabel(g.key) + ": " + g.orders.length + " הזמנות · " + g.orders.filter(isPacked).length + " ארוזות";
}
function renderHome() {
  let h = '<div class="home"><div class="bigs">' +
    '<button class="big private" data-act="go:private"><span class="en">PRIVATE</span><span class="t">פרטי</span><span class="s num">' + esc(homeCount("private")) + "</span></button>" +
    '<button class="big business" data-act="go:business"><span class="en">BUSINESS</span><span class="t">עסקי</span><span class="s num">' + esc(homeCount("business")) + "</span></button>" +
    '</div><div class="tiles"><button class="tile" data-act="go:deliver"><b>משלוחים</b><span>עצירות לפי יום משלוח</span></button>';
  if (isAdmin()) {
    const diffs = live().filter((o) => o.kind === "private" && isPacked(o) && orderDiff(o) !== 0).length;
    const rv = (D.review || []).length;
    if (rv) h += '<button class="tile" data-act="go:review" style="border-color:var(--danger)"><b style="color:var(--danger)">מיילים לבדיקה</b><span class="num">' + rv + " הזמנות מהאתר שלא נקלטו אוטומטית</span></button>";
    h += '<button class="tile" data-act="go:diffs"><b>הפרשי מחיר</b><span class="num">' + diffs + " הזמנות עם הפרש</span></button>" +
      '<button class="tile" data-act="go:trash"><b>סל מחזור</b><span class="num">' + D.orders.filter((o) => o.deleted_at).length + " הזמנות שנמחקו</span></button>" +
      '<button class="tile" data-act="go:log"><b>יומן פעולות</b><span>מה נעשה ומתי</span></button>' +
      '<button class="tile" data-act="go:settings"><b>הגדרות</b><span>מוצרים, לקוחות עסקיים, חגים</span></button>';
  }
  return h + "</div></div>";
}

function renderSection(kind) {
  const groups = sectionGroups(kind);
  let h = '<div class="' + kind + '-sec"><div class="toolbar">';
  if (isAdmin()) {
    h += '<button class="btn primary small" data-act="new:' + kind + '">+ הזמנה חדשה</button>' +
      '<button class="btn small" data-act="selmode" aria-pressed="' + ui.selectMode + '">' + (ui.selectMode ? "סיום בחירה" : "בחירה מרובה") + "</button>";
    if (ui.selectMode) h += '<button class="btn small" data-act="selall:' + kind + '">בחירת כל ה' + (kind === "private" ? "פרטיות" : "עסקיות") + "</button>";
  }
  h += '<span class="grow"></span><div class="seg" role="group" aria-label="מעבר בין חלקים"><button data-act="go:private" aria-pressed="' + (kind === "private") + '">פרטי</button><button data-act="go:business" aria-pressed="' + (kind === "business") + '">עסקי</button></div></div>';
  if (!groups.length) h += '<div class="empty">אין הזמנות פתוחות</div>';
  for (const g of groups) {
    const open = dayIsOpen(kind, g.key);
    const packed = g.orders.filter(isPacked).length;
    const parts = g.key === "overdue" ? { rel: "באיחור", base: "מימים קודמים" } : dayParts(g.key);
    h += '<section class="day ' + (open ? "" : "closed ") + (g.key === "overdue" ? "overdue" : "") + '">' +
      '<button class="dayhead" data-act="day:' + kind + ":" + g.key + '" aria-expanded="' + open + '"><span class="chev">' + CHEV + "</span>" +
      '<span class="lbl">' + (parts.rel ? '<span class="rel">' + parts.rel + "</span>" : "") + '<span class="num">' + esc(parts.base) + "</span></span>" +
      '<span class="cnt num"><b>' + packed + "</b> / " + g.orders.length + " ארוזות</span></button>";
    if (open) {
      if (g.key !== "overdue" && weekday(g.key) === 0) h += '<div class="daynote">יום ראשון: איסוף עצמי בלבד</div>';
      if (ui.selectMode && isAdmin()) h += '<label class="daysel"><input type="checkbox" data-act="selday:' + kind + ":" + g.key + '" ' + (g.orders.every((o) => ui.selected.has(o.id)) ? "checked" : "") + "> בחירת כל היום</label>";
      h += '<div class="list">';
      let pickHead = false;
      for (const o of g.orders) {
        if (o.pickup && !pickHead) { h += '<div class="subhead">איסוף עצמי</div>'; pickHead = true; }
        h += renderCard(o);
      }
      h += "</div>";
    }
    h += "</section>";
  }
  return h + "</div>";
}

function renderCard(o) {
  const open = ui.open.has(o.id);
  const sel = ui.selectMode && isAdmin();
  const its = items(o);
  const allConfirmed = its.length > 0 && its.every((i) => i.confirmed);
  const cls = ["card", o.pickup ? "pickup" : "", isPacked(o) ? "packed" : "", open ? "open" : "", isFired(o) ? "fired" : "", ui.flash === o.id ? "flash" : "", ui.shake === o.id ? "shake" : ""].join(" ");
  let l1, l2, l3 = "";
  if (o.kind === "private") {
    l1 = '<span class="onum num">#' + esc(o.number) + '</span><span class="oname">' + esc(o.customer_name) + "</span>" +
      (o.pickup ? '<span class="chip pick">איסוף עצמי</span>' : "") + (o.time_window ? '<span class="chip num">' + esc(o.time_window) + "</span>" : "") +
      (o.source === "manual" ? '<span class="chip">ידני</span>' : "");
    l2 = '<span class="ph num">' + esc(o.phone) + "</span>" + (o.pickup ? "" : "<span>" + esc(fullAddr(o.address)) + "</span>");
  } else {
    const c = client(o.client_id);
    l1 = '<span class="onum num">' + esc(o.number) + '</span><span class="oname">' + esc(c.business_name) + "</span>" +
      (o.pickup ? '<span class="chip pick">איסוף עצמי</span>' : "") +
      (isFired(o) ? '<span class="chip sea num">הופקה · מורנינג #' + esc(o.morning_doc_number) + "</span>" : "");
    l2 = (c.contact_name ? "<span>" + esc(c.contact_name) + "</span>" : "") + '<span class="ph num">' + esc(c.phone || "") + "</span>" + (o.pickup ? "" : "<span>" + esc(fullAddr(c.address)) + "</span>");
    if (c.legal_name || c.company_number) l3 = '<span class="l3 num">' + esc(c.legal_name || "") + (c.company_number ? " · ח.פ. " + esc(c.company_number) : "") + "</span>";
  }
  if (isPacked(o) && o.kind === "private" && isAdmin()) { const d = orderDiff(o); if (d) l1 += '<span class="chip ' + (d > 0 ? "warn" : "ok") + ' num">הפרש ' + (d > 0 ? "לחיוב " : "לזיכוי ") + nis(Math.abs(d)) + "</span>"; }
  let h = '<article class="' + cls + '" id="card-' + o.id + '"><div class="ch ' + (sel ? "" : "nosel") + '">';
  if (sel) h += '<label class="selbox"><input type="checkbox" aria-label="בחירת הזמנה ' + esc(o.number) + '" data-act="sel:' + o.id + '" ' + (ui.selected.has(o.id) ? "checked" : "") + "></label>";
  h += '<button class="info" data-act="toggle:' + o.id + '" aria-expanded="' + open + '"><span class="l1">' + l1 + '</span><span class="l2">' + l2 + "</span>" + l3 + "</button>" +
    '<div class="packcell"><div><button class="packbox ' + (!isPacked(o) && allConfirmed ? "ready" : "") + '" data-act="pack:' + o.id + '" aria-pressed="' + isPacked(o) + '" aria-label="' + (isPacked(o) ? "ארוזה. לחיצה לביטול אריזה" : "סימון כארוזה") + '">' + CHECK + '</button><div class="packlbl">' + (isPacked(o) ? "ארוזה" : "ארוזה?") + "</div>" +
    (isAdmin() && o.kind === "business" && o.status === "packed" ? '<button class="firemini" data-act="fire:' + o.id + '">FIRE</button>' : "") + "</div></div></div>";
  if (open) h += renderBody(o);
  return h + "</article>";
}

function renderBody(o) {
  const editing = ui.editing.has(o.id);
  const locked = isFired(o);
  let h = '<div class="body ' + (ui.opening === o.id ? "opening" : "") + '"><div class="items">';
  for (const it of items(o)) {
    const key = o.id + ":" + it.id;
    const p = unitPrice(o, it);
    const siteQty = o.kind === "private" && it.ordered_count && !it.added_during_packing ? '<div class="qty num">כמות באתר: ' + fmt(Number(it.ordered_count)) + "</div>" : "";
    let meta = it.unit === "kg"
      ? (siteQty ? "משקל משוער: " + kg(it.ordered_kg) + " ק״ג" : "הוזמן " + kg(it.ordered_kg || 0) + " ק״ג")
      : (siteQty ? "" : "הוזמנו " + fmt(Number(it.ordered_count || 0)) + " יח׳");
    if (it.added_during_packing) meta = "נוסף בעת האריזה";
    if (isAdmin() && p != null) meta += (meta ? " · " : "") + nis(round2(p)) + (it.unit === "kg" ? "/ק״ג" : "/יח׳");
    h += '<div class="item"><div><div class="iname">' + esc(it.name) + (it.option ? '<span class="chip opt">' + esc(it.option) + "</span>" : "") +
      (isAdmin() && o.kind === "business" && p == null ? '<span class="chip warn">אין מחיר שמור</span>' : "") + "</div>" +
      siteQty + (meta ? '<div class="imeta num">' + esc(meta) + "</div>" : "") + (it.note ? '<div class="inote">הערת לקוח: ' + esc(it.note) + "</div>" : "") +
      (ui.errs[key] ? '<div class="err">' + esc(ui.errs[key]) + "</div>" : "") + '</div><div class="wcell">';
    if (it.confirmed && !editing) {
      h += '<span class="final num">' + CHECK.replace("<svg", '<svg width="20" height="20" stroke="currentColor"') + amtText(it, it.final_amount) + "</span>";
      if (isAdmin() && o.kind === "private") { const d = itemDiff(o, it); if (Math.abs(d) >= 0.01) h += '<span class="diff num ' + (d > 0 ? "pos" : "neg") + '">' + (d > 0 ? "+" : "") + nis(d) + "</span>"; }
    } else if (!locked) {
      const val = ui.drafts[key] ?? (it.final_amount ?? "");
      h += '<input class="winput" id="w-' + key + '" data-key="' + key + '" inputmode="decimal" enterkeyhint="done" autocomplete="off" aria-label="' + (it.unit === "kg" ? "משקל סופי" : "כמות סופית") + " " + esc(it.name) + '" value="' + esc(val) + '"><span class="unit">' + unitLbl(it) + "</span>" +
        '<button class="okbtn" data-act="ok:' + key + '">אישור</button>';
      if (editing) h += '<button class="rm" data-act="rm:' + key + '" aria-label="הסרת ' + esc(it.name) + '">×</button>';
    }
    h += "</div></div>";
  }
  if (!items(o).length) h += '<div class="empty">אין פריטים</div>';
  h += "</div>";
  if (editing && !locked) {
    const a = ui.adding[o.id] || {};
    const ap = D.productsById[a.p];
    h += '<div class="addrow"><div class="field"><label for="ap-' + o.id + '">הוספת מוצר</label><select id="ap-' + o.id + '" data-addp="' + o.id + '"><option value="">בחירת מוצר…</option>' +
      D.products.filter((p) => p.active).map((p) => '<option value="' + p.id + '" ' + (a.p === p.id ? "selected" : "") + ">" + esc(p.name) + "</option>").join("") + "</select></div>" +
      '<div class="field amt"><label for="aa-' + o.id + '">' + (ap && ap.unit === "unit" ? "כמות (יח׳)" : "כמות (ק״ג)") + '</label><input id="aa-' + o.id + '" data-adda="' + o.id + '" inputmode="decimal" dir="ltr" value="' + esc(a.a || "") + '"></div>' +
      '<button class="btn small sea" data-act="add:' + o.id + '">הוספה</button></div>';
  }
  if (ui.notes[o.id]) h += '<div class="msg ' + ui.notes[o.id].cls + '">' + esc(ui.notes[o.id].text) + "</div>";
  h += '<div class="obar">';
  if (o.kind === "business" && !locked) h += '<button class="toggle" data-act="pickup:' + o.id + '" aria-pressed="' + o.pickup + '"><span class="sw"></span>איסוף עצמי</button>';
  if (!locked) h += '<button class="btn small" data-act="edit:' + o.id + '">' + (editing ? "סיום עריכה" : "עריכה") + "</button>";
  h += '<span class="grow"></span>';
  if (isAdmin()) {
    if (o.kind === "private") { if (isPacked(o)) { const d = orderDiff(o); h += '<span class="total num">הפרש: <b>' + (d ? (d > 0 ? "לחיוב " : "לזיכוי ") + nis(Math.abs(d)) : "אין") + "</b></span>"; } }
    else { const bt = bizTotal(o); h += '<span class="total num">סה״כ ' + (isPacked(o) ? "" : "משוער") + ": <b>" + nis(bt.total) + "</b>" + (bt.missing.length ? " (חסרים מחירים)" : "") + "</span>"; }
    if (!locked) h += '<button class="btn small" data-act="details:' + o.id + '">פרטי הזמנה</button><button class="btn small" data-act="del:' + o.id + '" style="color:var(--danger)">מחיקה</button>';
    if (o.kind === "business" && !locked) h += '<button class="btn small sea" data-act="fire:' + o.id + '">FIRE</button>';
  }
  h += "</div>";
  if (locked) h += '<div class="msg info">ההזמנה הופקה כתעודת משלוח במורנינג ולכן נעולה. תיקונים נעשים במורנינג.</div>';
  return h + "</div>";
}

function renderBulk() {
  const sel = [...ui.selected].map(byId).filter(Boolean);
  const p = sel.filter((o) => o.kind === "private").length, b = sel.length - p;
  return '<div class="bulk"><div class="wrap"><span class="grow num">נבחרו ' + sel.length + (sel.length ? " (" + p + " פרטיות · " + b + " עסקיות)" : "") + "</span>" +
    '<button class="btn small light" data-act="selclear" ' + (sel.length ? "" : "disabled") + ">ניקוי</button>" +
    '<button class="btn small light" data-act="bulkcsv" ' + (sel.length ? "" : "disabled") + ">ייצוא CSV</button>" +
    '<button class="btn small danger" data-act="bulkdel" ' + (sel.length ? "" : "disabled") + ">מחיקה</button></div></div>";
}

function deliverDays() {
  const t = TODAY();
  return [...new Set(live().filter((o) => !o.pickup && o.delivery_date >= t && isDeliveryDay(o.delivery_date)).map((o) => o.delivery_date))].sort();
}
async function loadRoute(day, force) {
  if (!force && day in ui.routes) return;
  ui.routes[day] = ui.routes[day] || null;
  try { ui.routes[day] = await B.loadRoute(day); } catch (e) { toast(e.message); }
  render();
}
async function routeCall(day, body, okToast) {
  ui.routeBusy = true; render();
  try { ui.routes[day] = await B.route({ ...body, day }); if (okToast) toast(okToast); }
  catch (e) { toast(e.message); }
  finally { ui.routeBusy = false; render(); }
}
let reorderTimer = null;
function moveStop(day, id, dir) {
  const r = ui.routes[day]; if (!r) return;
  const ids = deliverStops(day).map((o) => o.id);
  const i = ids.indexOf(id), j = i + dir; if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  r.stop_ids = ids; r.legs = []; r.optimized = false; render();
  clearTimeout(reorderTimer);
  reorderTimer = setTimeout(() => routeCall(day, { action: "reorder", order: ids }), 1500);
}
/** Stops in route order; orders that arrived after the route was made go at the end. */
function deliverStops(day) {
  const stops = live().filter((o) => o.delivery_date === day && !o.pickup);
  const r = ui.routes[day];
  if (!r) return sortDay(stops);
  const pos = new Map(r.stop_ids.map((id, i) => [id, i]));
  return stops.slice().sort((a, b) => (pos.get(a.id) ?? 1e6) - (pos.get(b.id) ?? 1e6) || String(a.number).localeCompare(String(b.number), "en", { numeric: true }));
}
/** Google Maps directions links for the stops in order. Google takes at most 9 stops between start and end,
 *  so longer days are split into parts that follow on from each other. */
const MAP_STOPS = 9;
function mapLinks(day, stops, r, endMode) {
  const shopTxt = setting("shop_address", "מקווה ישראל 22, תל אביב");
  const where = (o) => {
    const pt = r && r.points ? r.points[o.id] : null;
    if (pt) return pt.lat + "," + pt.lng;
    const a = o.kind === "business" ? (client(o.client_id) || {}).address : o.address;
    return a && a.street ? [a.street + (a.building ? " " + a.building : ""), a.city || "תל אביב"].join(", ") : null;
  };
  const pts = [shopTxt, ...stops.map(where).filter(Boolean)];
  if (endMode === "shop") pts.push(shopTxt);
  else if (endMode === "custom" && ((r && r.end_label) || setting("route_end_address", ""))) pts.push((r && r.end_label) || setting("route_end_address", ""));
  if (pts.length < 2) return [];
  const links = [];
  for (let i = 0; i < pts.length - 1; i += MAP_STOPS + 1) {
    const part = pts.slice(i, i + MAP_STOPS + 2);
    links.push("https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=" + encodeURIComponent(part[0]) +
      "&destination=" + encodeURIComponent(part[part.length - 1]) +
      (part.length > 2 ? "&waypoints=" + encodeURIComponent(part.slice(1, -1).join("|")) : ""));
  }
  return links;
}
const mins = (s) => Math.max(1, Math.round(s / 60));
const hm = (s) => { const m = Math.round(s / 60); return m >= 60 ? Math.floor(m / 60) + " ש׳ " + (m % 60) + " דק׳" : m + " דק׳"; };

function renderDeliver() {
  const days = deliverDays();
  const day = ui.deliverDay && days.includes(ui.deliverDay) ? ui.deliverDay : days[0];
  let h = '<div class="toolbar no-print"><div class="seg" role="group" aria-label="יום משלוח">' + days.map((d) => '<button class="num" data-act="dday:' + d + '" aria-pressed="' + (d === day) + '">' + esc(dayLabel(d)) + "</button>").join("") + "</div></div>";
  if (!day) return h + '<div class="empty">אין משלוחים מתוכננים</div>';
  if (!(day in ui.routes)) { loadRoute(day); }
  const r = ui.routes[day];
  const stops = deliverStops(day);
  const inRoute = new Set(r ? r.stop_ids : []);
  const fresh = r ? stops.filter((o) => !inRoute.has(o.id)) : [];
  const unfound = new Set(r ? r.unfound : []);
  const unpacked = stops.filter((o) => !isPacked(o)).length;
  const endMode = r ? r.end_mode : setting("route_end", "shop");
  const endLabel = endMode === "shop" ? "חזרה לחנות" : endMode === "custom" ? "סיום: " + ((r && r.end_label) || setting("route_end_address", "")) : null;
  // Drive times only match while the stops are exactly the ones the route was made for.
  const here = new Set(stops.map((o) => o.id));
  const gone = r ? r.stop_ids.filter((id) => !here.has(id)).length : 0;
  const placed = r ? r.stop_ids.length - (r.unfound || []).length : 0;
  const legsOk = r && r.legs && r.legs.length && !fresh.length && !gone;
  const maps = mapLinks(day, stops, r, endMode);
  h += '<div class="panel route-head"><div class="print-only"><img src="logo-white.png" alt="" class="print-logo"></div>' +
    '<h2 class="num">' + esc(dayLabel(day)) + " · " + stops.length + " עצירות" + (legsOk ? " · " + hm(r.total_seconds) + " נסיעה · " + fmt(r.total_meters / 1000, 1) + " ק״מ" : "") + "</h2>" +
    '<div class="rowform no-print"><button class="btn small sea" data-act="route-opt:' + day + '" ' + (ui.routeBusy ? "disabled" : "") + ">" + (ui.routeBusy ? "מחשב מסלול…" : r ? "סידור מסלול מחדש" : "סידור מסלול אוטומטי") + '</button><button class="btn small" data-act="route-pdf" ' + (stops.length ? "" : "disabled") + ">ייצוא PDF</button>" +
    maps.map((u, k) => '<a class="btn small" href="' + esc(u) + '" target="_blank" rel="noopener">' + (maps.length > 1 ? "מפה " + (k + 1) + "/" + maps.length : "פתיחה במפות Google") + "</a>").join("") + "</div>" +
    (maps.length > 1 ? '<p class="stamp no-print">Google Maps מקבל עד ' + MAP_STOPS + " עצירות בכל פעם, לכן המסלול מחולק ל-" + maps.length + " חלקים. כל חלק מתחיל איפה שהקודם נגמר.</p>" : "") +
    (r ? '<p class="stamp no-print">' + (r.optimized ? "מסלול מהיר ביותר לפי Google" : "סדר ידני") + " · עודכן " + esc(new Intl.DateTimeFormat("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(r.computed_at))) + "</p>" : '<p class="no-print">לחצו על "סידור מסלול אוטומטי" כדי לקבל את הסדר המהיר ביותר מהחנות.</p>') +
    (fresh.length || gone ? '<div class="msg info no-print">' + (fresh.length ? fresh.length + " הזמנות נוספו" : "") + (fresh.length && gone ? " ו-" : "") + (gone ? gone + " הזמנות הוסרו או שונו" : "") + " אחרי חישוב המסלול. לחצו \"סידור מסלול מחדש\".</div>" : "") +
    (unfound.size ? '<div class="msg bad">' + unfound.size + ' כתובות לא נמצאו במפה. תקנו אותן ב"פרטי הזמנה" ואז חשבו מחדש.</div>' : "") +
    (unpacked ? '<div class="msg bad num no-print">' + unpacked + " הזמנות עדיין לא ארוזות</div>" : '<div class="msg good no-print">כל ההזמנות ארוזות</div>') + "</div>";
  h += '<div class="stops"><div class="stop start"><span class="n">⌂</span><div><b>יציאה</b><div class="imeta">' + esc(setting("shop_address", "מקווה ישראל 22, תל אביב")) + "</div></div><span></span></div>";
  stops.forEach((o, i) => {
    const c = o.kind === "business" ? client(o.client_id) : null;
    const pt = r && r.points ? r.points[o.id] : null;
    const leg = legsOk && i < placed ? r.legs[i] : null;
    const nav = pt ? "https://waze.com/ul?ll=" + pt.lat + "," + pt.lng + "&navigate=yes" : "https://waze.com/ul?q=" + encodeURIComponent(fullAddr(c ? c.address : o.address)) + "&navigate=yes";
    const notes = items(o).filter((it) => it.note).length;
    h += '<div class="stop' + (unfound.has(o.id) ? " bad" : "") + '"><span class="n num">' + (i + 1) + '</span><div style="min-width:0">' +
      (leg ? '<div class="stamp num">' + mins(leg.seconds) + " דק׳ מהעצירה הקודמת</div>" : "") +
      "<b>" + esc(oName(o)) + '</b> <span class="onum num">' + (o.kind === "private" ? "#" : "") + esc(o.number) + "</span>" +
      '<div class="imeta">' + esc(fullAddr(c ? c.address : o.address)) + (unfound.has(o.id) ? ' <span class="chip warn">כתובת לא נמצאה</span>' : "") + "</div>" +
      '<div class="imeta num">' + esc(c ? c.phone || "" : o.phone) + " · " + items(o).length + " פריטים" + (o.time_window ? " · " + esc(o.time_window) : "") + (notes ? " · " + notes + " הערות" : "") + "</div>" +
      '<div class="print-only imeta">ניווט: ' + esc(nav) + "</div></div>" +
      '<div class="stopact no-print">' + (isPacked(o) ? '<span class="chip ok">ארוזה</span>' : '<span class="chip warn">לא ארוזה</span>') +
      '<a class="btn small" href="' + esc(nav) + '" target="_blank" rel="noopener">Waze</a>' +
      (r ? '<span class="updown"><button class="ghost" data-act="mv:' + day + ":" + o.id + ':-1" aria-label="למעלה" ' + (i ? "" : "disabled") + '>▲</button><button class="ghost" data-act="mv:' + day + ":" + o.id + ':1" aria-label="למטה" ' + (i < stops.length - 1 ? "" : "disabled") + ">▼</button></span>" : "") + "</div></div>";
  });
  if (endLabel) h += '<div class="stop start"><span class="n">' + (endMode === "shop" ? "⌂" : "◎") + "</span><div>" + (legsOk ? '<div class="stamp num">' + mins(r.legs[r.legs.length - 1].seconds) + " דק׳ מהעצירה האחרונה</div>" : "") + "<b>" + esc(endLabel) + "</b></div><span></span></div>";
  return h + "</div>";
}

function diffOrders() { return live().filter((o) => o.kind === "private" && isPacked(o) && orderDiff(o) !== 0).sort((a, b) => (a.delivery_date < b.delivery_date ? -1 : 1)); }
function renderDiffs() {
  const os = diffOrders();
  const sum = round2(os.reduce((s, o) => s + orderDiff(o), 0));
  let h = '<div class="panel"><h2>הפרשי מחיר בהזמנות פרטיות</h2><p>חיובי = הלקוח צריך להשלים תשלום. שלילי = זיכוי ללקוח. דמי משלוח לא נכללים.</p>' +
    '<div class="toolbar" style="margin:0"><span class="total num">סה״כ נטו: <b>' + nis(sum) + '</b></span><span class="grow"></span><button class="btn small sea" data-act="diffcsv" ' + (os.length ? "" : "disabled") + ">ייצוא CSV</button></div>";
  if (!os.length) return h + '<div class="empty">אין עדיין הפרשים. הם יופיעו כאן אחרי אריזת הזמנות שמשקלן הסופי שונה מההזמנה.</div></div>';
  h += '<div class="tscroll"><table class="t"><thead><tr><th>הזמנה</th><th>יום</th><th>לקוח</th><th>טלפון</th><th>פירוט</th><th>הפרש</th></tr></thead><tbody>';
  for (const o of os) {
    const lines = o.order_items.filter((it) => Math.abs(itemDiff(o, it)) >= 0.01).map((it) => it.name + ": " + (it.removed_at ? "הוסר" : (it.added_during_packing ? "נוסף " : amtText(it, orderedAmount(it)) + " → ") + amtText(it, it.final_amount)));
    const d = orderDiff(o);
    h += '<tr><td class="num">#' + esc(o.number) + '</td><td class="num">' + esc(dayParts(o.delivery_date).base) + "</td><td>" + esc(o.customer_name) + '</td><td class="num" dir="ltr">' + esc(o.phone) + '</td><td style="font-size:13px;color:var(--muted)">' + lines.map(esc).join("<br>") + '</td><td class="num" style="font-weight:700;color:' + (d > 0 ? "var(--danger)" : "var(--ok)") + '">' + (d > 0 ? "+" : "") + nis(d) + "</td></tr>";
  }
  return h + "</tbody></table></div></div>";
}

function renderTrash() {
  const os = D.orders.filter((o) => o.deleted_at).sort((a, b) => (b.deleted_at > a.deleted_at ? 1 : -1));
  let h = '<div class="panel"><h2>סל מחזור</h2><p>הזמנות שנמחקו נשמרות 30 יום ואפשר לשחזר אותן.</p>';
  if (!os.length) return h + '<div class="empty">סל המחזור ריק</div></div>';
  h += '<div class="tscroll"><table class="t"><thead><tr><th>הזמנה</th><th>לקוח</th><th>יום</th><th>נמחקה</th><th></th></tr></thead><tbody>';
  for (const o of os) {
    const left = 30 - Math.floor((Date.now() - new Date(o.deleted_at).getTime()) / 864e5);
    h += '<tr><td class="num">' + esc(o.kind === "private" ? "#" + o.number : o.number) + "</td><td>" + esc(oName(o)) + '</td><td class="num">' + esc(dayParts(o.delivery_date).base) + '</td><td class="num">נותרו ' + Math.max(left, 0) + ' ימים</td><td><button class="btn small" data-act="restore:' + o.id + '">שחזור</button></td></tr>';
  }
  return h + "</tbody></table></div></div>";
}

function renderReview() {
  const rs = D.review || [];
  let h = '<div class="panel"><h2>מיילים לבדיקה</h2><p>הזמנות מהאתר שהאפליקציה לא קלטה אוטומטית. בדקו את המייל, צרו הזמנה ידנית אם צריך, וסמנו כטופל.</p>';
  if (!rs.length) return h + '<div class="empty">אין מיילים לבדיקה</div></div>';
  const f = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
  h += '<div class="list">';
  for (const r of rs) {
    const p = r.parsed;
    h += '<div class="panel" style="gap:8px"><div class="l1"><b>' + esc(r.subject || "מייל") + '</b></div><div class="stamp num">התקבל ' + (r.received_at ? esc(f.format(new Date(r.received_at))) : "") + "</div>" +
      '<div class="msg bad">' + esc(r.problem || "") + "</div>";
    if (p) h += '<div class="imeta num">' + esc([p.customer_name, p.phone, p.delivery_date && dayLabel(p.delivery_date), p.pickup ? "איסוף עצמי" : fullAddr(p.address)].filter(Boolean).join(" · ")) + "</div>" +
      '<div class="imeta">' + (p.items || []).map((i) => esc(i.name + " ×" + i.count + (i.kg ? " (" + i.kg + " ק״ג)" : ""))).join("<br>") + "</div>";
    h += '<div class="obar"><a class="btn small" href="https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(r.gmail_id) + '" target="_blank" rel="noopener">פתיחה בג׳ימייל</a>' +
      (p ? '<button class="btn small sea" data-act="review-create:' + r.id + '">יצירת הזמנה ידנית</button>' : "") +
      '<span class="grow"></span><button class="btn small" data-act="review-done:' + r.id + '">סומן כטופל</button></div></div>';
  }
  return h + "</div></div>";
}
function openFormFromEmail(rid) {
  const r = (D.review || []).find((x) => x.id === rid); const p = r && r.parsed; if (!p) return;
  const byName = Object.fromEntries(D.products.map((x) => [x.name, x]));
  const d = p.delivery_date && p.delivery_date >= TODAY() ? p.delivery_date : nextDeliveryDay(TODAY(), { inclusive: true, holidays: holidays() });
  ui.modal = { type: "form", kind: "private", id: null, wide: true,
    values: { customer_name: p.customer_name, phone: p.phone, pickup: !!p.pickup, delivery_date: d, time_window: p.time_window, ...(p.address || {}) },
    rows: (p.items || []).map((i) => { const pr = byName[i.name]; return { p: pr ? pr.id : "", a: pr && pr.unit === "kg" ? i.kg : i.count }; }).concat(p.items && p.items.length ? [] : [{}]) };
  render();
}

const ACTIONS = { email_imported: "נקלטה ממייל", email_updated: "עודכנה ממייל", packed: "סימן כארוזה", unpacked: "ביטל אריזה", weight_changed: "שינה משקל", item_added: "הוסיף פריט", item_removed: "הסיר פריט", pickup_on: "סימן איסוף עצמי", pickup_off: "ביטל איסוף עצמי", deleted: "מחק", restored: "שחזר", edited: "ערך פרטים", created: "יצר הזמנה", fired: "הפיק במורנינג" };
const ACTORS = { employee: "עובד", admin: "מנהל", whatsapp: "וואטסאפ", system: "מערכת" };
function renderLog() {
  let h = '<div class="panel"><h2>יומן פעולות</h2><p>בשלב זה יש כניסה משותפת לעובדים, לכן היומן מציין "עובד" או "מנהל".</p>';
  if (!ui.log) { loadLog(); return h + '<div class="loading">טוען…</div></div>'; }
  if (!ui.log.length) return h + '<div class="empty">אין עדיין פעולות</div></div>';
  h += '<div class="tscroll"><table class="t"><thead><tr><th>זמן</th><th>מי</th><th>פעולה</th><th>הזמנה</th></tr></thead><tbody>';
  const f = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
  for (const e of ui.log) {
    let what = ACTIONS[e.action] || e.action;
    if (e.details && e.details.item) what += " · " + e.details.item + (e.details.from != null ? " " + fmt(Number(e.details.from)) + " → " + fmt(Number(e.details.to)) : "");
    h += '<tr><td class="num">' + esc(f.format(new Date(e.at))) + "</td><td>" + esc(ACTORS[e.actor] || e.actor) + "</td><td>" + esc(what) + '</td><td class="num">' + esc(e.order_number || "") + "</td></tr>";
  }
  return h + "</tbody></table></div></div>";
}
async function loadLog() { try { ui.log = await B.loadLog(); } catch (e) { ui.log = []; toast(e.message); } render(); }

function renderSettings() {
  const prods = D.products.slice().sort((a, b) => a.name.localeCompare(b.name, "he"));
  let h = '<div class="setgrid">';
  // holidays
  h += '<div class="panel"><h2>חגים וימי סגירה</h2><p>בימים האלה אין משלוחים ואין איסוף.</p><div class="rowform"><div class="field"><label for="hol-d">תאריך</label><input id="hol-d" type="date"></div><div class="field"><label for="hol-n">הערה</label><input id="hol-n" placeholder="למשל: יום כיפור"></div><button class="btn small sea" data-act="hol-add">הוספה</button></div>';
  h += D.holidays.length ? '<div class="tscroll"><table class="t"><tbody>' + D.holidays.map((x) => '<tr><td class="num">' + esc(dayParts(x.day).base) + " " + esc(x.day.slice(0, 4)) + "</td><td>" + esc(x.note) + '</td><td><button class="linkbtn danger" data-act="hol-del:' + x.day + '">הסרה</button></td></tr>').join("") + "</tbody></table></div>" : '<p class="muted">אין ימי סגירה מתוכננים.</p>';
  h += "</div>";
  // route end
  const re = setting("route_end", "shop");
  h += '<div class="panel"><h2>סוף מסלול המשלוחים</h2><div class="seg" role="group"><button data-act="route:shop" aria-pressed="' + (re === "shop") + '">חזרה לחנות</button><button data-act="route:last_stop" aria-pressed="' + (re === "last_stop") + '">בעצירה האחרונה</button><button data-act="route:custom" aria-pressed="' + (re === "custom") + '">כתובת אחרת</button></div>' +
    (re === "custom" ? '<div class="rowform"><div class="field"><label for="end-addr">כתובת סיום (רחוב, מספר, עיר)</label><input id="end-addr" value="' + esc(setting("route_end_address", "")) + '" placeholder="למשל: הרצל 10, ראשון לציון"></div><button class="btn small sea" data-act="end-addr-save">שמירה</button></div>' +
      (setting("route_end_address", "") ? "" : '<div class="msg bad">הזינו כתובת ושמרו, אחרת לא ניתן לחשב מסלול.</div>') : "") +
    '<p class="muted">השינוי חל על המסלול הבא שמחשבים.</p></div>';
  // clients
  h += '<div class="panel"><h2>מורנינג</h2><p>לקוחות עסקיים מגיעים ממורנינג. הסנכרון מוסיף לקוחות חדשים ומעדכן פרטי חברה, טלפון וכתובת. שמות העסקים שערכתם כאן נשמרים.</p>' +
    '<div class="rowform"><button class="btn small sea" data-act="morning-sync">סנכרון לקוחות ממורנינג</button><button class="btn small" data-act="morning-test">בדיקת חיבור</button></div></div>';
  h += '<div class="panel"><h2>לקוחות עסקיים</h2><p>אפשר גם להוסיף לקוח ידנית. כדי להפיק לו תעודות משלוח הוא צריך להיות קיים גם במורנינג.</p>' +
    '<div class="rowform"><div class="field"><label for="cl-b">שם העסק</label><input id="cl-b"></div><div class="field"><label for="cl-c">איש קשר</label><input id="cl-c"></div><div class="field"><label for="cl-p">טלפון</label><input id="cl-p" dir="ltr"></div></div>' +
    '<div class="rowform"><div class="field"><label for="cl-l">שם החברה</label><input id="cl-l"></div><div class="field"><label for="cl-h">ח.פ.</label><input id="cl-h" dir="ltr"></div><div class="field"><label for="cl-city">עיר</label><input id="cl-city"></div><div class="field"><label for="cl-st">רחוב ומספר</label><input id="cl-st"></div><button class="btn small sea" data-act="client-add">הוספה</button></div>';
  const shown = clientMatches(ui.clientQ);
  h += '<div class="field"><label for="cl-search">חיפוש לקוח (' + D.clients.length.toLocaleString("he-IL") + ' לקוחות)</label><input id="cl-search" data-search="clients" value="' + esc(ui.clientQ || "") + '" placeholder="שם, ח.פ. או טלפון" autocomplete="off"></div>' +
    (!ui.clientQ ? '<p class="muted">' + (shown.length ? "מוצגים לקוחות שיש להם מחירון. חפשו כדי למצוא אחרים." : "חפשו לקוח כדי לראות או לערוך את המחירון שלו.") + "</p>" : !shown.length ? '<p class="muted">לא נמצא לקוח</p>' : "");
  if (shown.length) h += '<div class="tscroll"><table class="t"><thead><tr><th>עסק</th><th>איש קשר</th><th>טלפון</th><th>כתובת</th><th>מחירים</th></tr></thead><tbody>' +
    shown.map((c) => "<tr><td>" + esc(c.business_name) + "</td><td>" + esc(c.contact_name || "") + '</td><td class="num" dir="ltr">' + esc(c.phone || "") + "</td><td>" + esc(fullAddr(c.address)) + '</td><td><button class="btn small" data-act="prices:' + c.id + '">מחירון (' + Object.keys(D.priceMap[c.id] || {}).length + ")</button></td></tr>").join("") + "</tbody></table></div>";
  h += "</div>";
  // products
  h += '<div class="panel"><h2>מוצרים</h2><p>מחיר באתר משמש לחישוב הפרש כשמוסיפים מוצר בזמן האריזה.</p>' +
    '<div class="rowform"><div class="field"><label for="pr-n">שם המוצר</label><input id="pr-n"></div><div class="field"><label for="pr-u">יחידה</label><select id="pr-u"><option value="kg">ק״ג</option><option value="unit">יחידה</option></select></div><div class="field"><label for="pr-p">מחיר באתר (₪)</label><input id="pr-p" inputmode="decimal" dir="ltr"></div><button class="btn small sea" data-act="prod-add">הוספה</button></div>' +
    '<div class="tscroll"><table class="t"><thead><tr><th>מוצר</th><th>יחידה</th><th>מחיר באתר</th><th></th></tr></thead><tbody>' +
    prods.map((p) => '<tr class="' + (p.active ? "" : "muted") + '"><td>' + esc(p.name) + "</td><td>" + (p.unit === "kg" ? "ק״ג" : "יחידה") + '</td><td class="num">' + (p.site_price != null ? nis(Number(p.site_price)) : "") + '</td><td><button class="linkbtn" data-act="prod-toggle:' + p.id + '">' + (p.active ? "השבתה" : "הפעלה") + "</button></td></tr>").join("") +
    "</tbody></table></div></div>";
  return h + "</div>";
}

/* ---------- modals ---------- */
let modalRun = null;
function openConfirm({ title, body, ok, danger, run }) { ui.modal = { type: "confirm", title, body, ok, danger }; modalRun = run; render(); setTimeout(() => document.getElementById("m-ok")?.focus(), 0); }
function closeModal() { ui.modal = null; modalRun = null; render(); }

const COLS = [
  ["number", "מספר הזמנה", 1], ["kind", "סוג", 1], ["date", "יום", 1], ["mode", "משלוח / איסוף", 1], ["window", "חלון זמן", 0],
  ["name", "לקוח / איש קשר", 1], ["business", "עסק", 1], ["company", "חברה וח.פ.", 0], ["phone", "טלפון", 1], ["address", "כתובת", 1],
  ["item", "פריט", 1], ["option", "אפשרות", 0], ["note", "הערת לקוח", 0], ["ordered", "כמות שהוזמנה", 1], ["unit", "יחידה", 1],
  ["final", "משקל / כמות סופית", 1], ["ppu", "מחיר ליחידה", 0], ["diff", "הפרש מחיר (₪)", 1], ["status", "סטטוס", 1], ["doc", "מסמך במורנינג", 1],
];
const DIFF_COLS = [
  ["number", "מספר הזמנה", 1], ["date", "יום", 1], ["name", "לקוח", 1], ["phone", "טלפון", 1], ["item", "פריט", 1], ["ordered", "כמות שהוזמנה", 1],
  ["unit", "יחידה", 1], ["final", "משקל / כמות סופית", 1], ["ppu", "מחיר ליחידה", 1], ["diff", "הפרש פריט (₪)", 1], ["odiff", "הפרש הזמנה (₪)", 1],
];
const STATUS = { new: "חדשה", packed: "ארוזה", fired: "הופקה" };

function renderModal() {
  const m = ui.modal;
  let h = '<div class="scrim" data-act="scrim"><div class="modal ' + (m.wide ? "wide" : "") + '" role="dialog" aria-modal="true" aria-labelledby="m-title">';
  if (m.type === "confirm") {
    h += '<h3 id="m-title">' + esc(m.title) + "</h3><p>" + esc(m.body) + '</p><div class="mact"><button id="m-ok" class="btn ' + (m.danger ? "danger" : "primary") + '" data-act="m-ok">' + esc(m.ok) + '</button><button class="btn" data-act="m-close">ביטול</button></div>';
  } else if (m.type === "csv") {
    const cols = m.mode === "diffs" ? DIFF_COLS : COLS;
    h += '<h3 id="m-title">ייצוא CSV</h3>';
    if (m.mode === "orders") h += '<p>מה לייצא?</p><div class="checks"><label><input type="checkbox" id="x-private" ' + (m.counts.private ? "checked" : "disabled") + "> פרטיות (" + m.counts.private + ')</label><label><input type="checkbox" id="x-business" ' + (m.counts.business ? "checked" : "disabled") + "> עסקיות (" + m.counts.business + ")</label></div><p>כשמייצאים את שתיהן, הן באותו קובץ: פרטיות, שתי שורות ריקות, ואז עסקיות.</p>";
    h += '<p>עמודות:</p><div class="checks">' + cols.map((c) => '<label><input type="checkbox" id="col-' + c[0] + '" ' + (c[2] ? "checked" : "") + "> " + esc(c[1]) + "</label>").join("") + "</div>" +
      (m.err ? '<div class="err">' + esc(m.err) + "</div>" : "") + '<div class="mact"><button class="btn primary" data-act="m-csv">ייצוא</button><button class="btn" data-act="m-close">ביטול</button></div>';
  } else if (m.type === "csvtext") {
    h += '<h3 id="m-title">הקובץ מוכן</h3><p>הדפדפן לא אפשר הורדה. העתיקו את התוכן והדביקו בגיליון.</p><textarea class="csv" id="csvtext" readonly>' + esc(m.text) + '</textarea><div class="mact"><button class="btn primary" data-act="m-copy">העתקה</button><button class="btn" data-act="m-close">סגירה</button></div>';
  } else if (m.type === "fire") {
    const o = byId(m.id), c = client(o.client_id), bt = bizTotal(o);
    h += '<h3 id="m-title">הפקת תעודת משלוח במורנינג</h3><p>' + esc(o.number) + " · " + esc(c.business_name) + (c.legal_name ? " · " + esc(c.legal_name) : "") + (c.company_number ? " (ח.פ. " + esc(c.company_number) + ")" : "") + "</p>" +
      '<div class="tscroll"><table class="t"><thead><tr><th>פריט</th><th>כמות</th><th>מחיר</th><th>סה״כ</th></tr></thead><tbody>' +
      items(o).map((it) => { const p = unitPrice(o, it); const amt = it.confirmed ? it.final_amount : orderedAmount(it); return "<tr><td>" + esc(it.name) + '</td><td class="num">' + amtText(it, amt) + '</td><td class="num">' + (p == null ? '<span class="chip warn">חסר</span>' : nis(p)) + '</td><td class="num">' + (p == null ? "" : nis(round2(amt * p))) + "</td></tr>"; }).join("") +
      '</tbody></table></div><div class="total num">סה״כ לפני מע״מ: <b>' + nis(bt.total) + "</b></div>" +
      (!isPacked(o) ? '<div class="msg bad">יש לארוז את ההזמנה לפני ההפקה.</div>' : "") +
      (bt.missing.length ? '<div class="msg bad">חסר מחיר שמור ללקוח עבור: ' + esc(bt.missing.join(", ")) + '. הוסיפו מחיר ב"פרטי הזמנה".</div>' : "") +
      (!c.morning_id ? '<div class="msg bad">הלקוח לא מקושר למורנינג. הריצו "סנכרון לקוחות ממורנינג" בהגדרות.</div>' : "") +
      (m.err ? '<div class="msg bad">' + esc(m.err) + "</div>" : "") +
      '<p>ההפקה יוצרת תעודת משלוח אמיתית במורנינג ונועלת את ההזמנה.</p>' +
      '<div class="mact"><button class="btn sea" data-act="m-fire" ' + (isPacked(o) && !bt.missing.length && c.morning_id && !ui.busy ? "" : "disabled") + ">" + (ui.busy ? "מפיק…" : "הפקת תעודת משלוח") + '</button><button class="btn" data-act="m-close">ביטול</button></div>';
  } else if (m.type === "prices") {
    const c = client(m.cid);
    h += '<h3 id="m-title">מחירון · ' + esc(c.business_name) + '</h3><p>מחיר לפני מע״מ, לק״ג או ליחידה. נשמר עד שמשנים אותו.</p><div class="pricegrid">' +
      D.products.filter((p) => p.active).map((p) => { const v = (D.priceMap[m.cid] || {})[p.id]; return '<label for="cp-' + p.id + '">' + esc(p.name) + " <span class=\"muted\">(" + (p.unit === "kg" ? "ק״ג" : "יח׳") + ')</span></label><input id="cp-' + p.id + '" data-cprice="' + p.id + '" inputmode="decimal" value="' + esc(v ?? "") + '" placeholder="—">'; }).join("") +
      "</div>" + (m.err ? '<div class="err">' + esc(m.err) + "</div>" : "") + '<div class="mact"><button class="btn primary" data-act="m-prices">שמירה</button><button class="btn" data-act="m-close">ביטול</button></div>';
  } else if (m.type === "form") h += renderOrderForm(m);
  return h + "</div></div>";
}

function dateOptions(sel) {
  const days = upcomingOpenDays(14, TODAY(), holidays());
  if (sel && !days.includes(sel)) days.unshift(sel);
  return days.map((d) => '<option value="' + d + '" ' + (d === sel ? "selected" : "") + ">" + esc(dayLabel(d)) + (weekday(d) === 0 ? " (איסוף בלבד)" : "") + "</option>").join("");
}
const fld = (id, label, val, dir) => '<div class="field"><label for="' + id + '">' + esc(label) + '</label><input id="' + id + '" ' + (dir ? 'dir="' + dir + '"' : "") + ' value="' + esc(val || "") + '"></div>';
const gv = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };

function renderOrderForm(m) {
  const v = m.values, isNew = !m.id;
  let h = '<h3 id="m-title">' + (isNew ? "הזמנה " + (m.kind === "private" ? "פרטית" : "עסקית") + " חדשה" : "פרטי הזמנה " + esc(byId(m.id).number)) + '</h3><div class="grid2">';
  if (m.kind === "private") {
    h += fld("f-name", "שם לקוח", v.customer_name) + fld("f-phone", "טלפון", v.phone, "ltr") +
      '<div class="field"><label for="f-type">סוג</label><select id="f-type"><option value="delivery" ' + (!v.pickup ? "selected" : "") + '>משלוח</option><option value="pickup" ' + (v.pickup ? "selected" : "") + ">איסוף עצמי</option></select></div>" +
      '<div class="field"><label for="f-date">יום</label><select id="f-date">' + dateOptions(v.delivery_date) + "</select></div>" +
      fld("f-window", "חלון זמן", v.time_window, "ltr") + fld("f-city", "עיר", v.city) + fld("f-street", "רחוב", v.street) + fld("f-building", "מספר בניין", v.building) +
      fld("f-entrance", "כניסה", v.entrance) + fld("f-floor", "קומה", v.floor) + fld("f-apt", "דירה", v.apt);
  } else {
    const chosen = v.client_id ? client(v.client_id) : null;
    h += '<div class="field" style="grid-column:1/-1"><label for="f-client-q">לקוח</label><input type="hidden" id="f-client" value="' + esc(v.client_id || "") + '">' +
      (chosen ? '<div class="rowform"><b>' + esc(chosen.business_name) + '</b>' + (chosen.company_number ? ' <span class="muted num">ח.פ. ' + esc(chosen.company_number) + "</span>" : "") + '<button class="linkbtn" data-act="client-clear">החלפה</button></div>'
        : '<input id="f-client-q" data-search="formclient" value="' + esc(v.client_q || "") + '" placeholder="הקלידו שם לקוח, ח.פ. או טלפון" autocomplete="off">' +
          (v.client_q ? '<div class="picklist">' + (clientMatches(v.client_q, 8).map((c) => '<button class="clientpick" data-act="pick-client:' + c.id + '">' + esc(c.business_name) + (c.company_number ? ' <span class="muted num">' + esc(c.company_number) + "</span>" : "") + "</button>").join("") || '<span class="muted">לא נמצא לקוח</span>') + "</div>" : "")) + "</div>" +
      '<div class="field"><label for="f-date">יום</label><select id="f-date">' + dateOptions(v.delivery_date) + "</select></div>" +
      '<div class="field"><label for="f-pick">איסוף עצמי</label><select id="f-pick"><option value="0" ' + (!v.pickup ? "selected" : "") + '>לא, משלוח</option><option value="1" ' + (v.pickup ? "selected" : "") + ">כן</option></select></div>";
  }
  h += "</div>";
  if (isNew) {
    h += "<p>" + (m.kind === "business" ? "פריטים. המחיר ללקוח נשמר ונשאר עד שמשנים אותו." : "פריטים") + "</p>";
    m.rows.forEach((r, i) => {
      const p = D.productsById[r.p];
      const saved = m.kind === "business" && r.p ? (D.priceMap[v.client_id] || {})[r.p] : null;
      h += '<div class="irow ' + (m.kind === "business" ? "" : "np") + '"><div class="field f-prod"><label for="r-p-' + i + '">מוצר</label><select id="r-p-' + i + '" data-row="' + i + '"><option value="">בחירה…</option>' + D.products.filter((x) => x.active).map((x) => '<option value="' + x.id + '" ' + (x.id === r.p ? "selected" : "") + ">" + esc(x.name) + "</option>").join("") + "</select></div>" +
        '<div class="field"><label for="r-a-' + i + '">' + (p && p.unit === "unit" ? "יח׳" : "ק״ג") + '</label><input id="r-a-' + i + '" inputmode="decimal" dir="ltr" value="' + esc(r.a || "") + '"></div>' +
        (m.kind === "business" ? '<div class="field"><label for="r-c-' + i + '">₪ ל' + (p && p.unit === "unit" ? "יח׳" : "ק״ג") + '</label><input id="r-c-' + i + '" inputmode="decimal" dir="ltr" placeholder="' + (saved == null ? "אין שמור" : "") + '" value="' + esc(r.c != null && r.c !== "" ? r.c : saved ?? "") + '"></div>' : "") +
        '<button class="rm" data-act="m-rmrow:' + i + '" aria-label="הסרת שורה">×</button></div>';
    });
    h += '<div><button class="linkbtn" data-act="m-addrow">+ שורה</button></div>';
  } else if (m.kind === "business") {
    const o = byId(m.id);
    h += "<p>מחירים שמורים ללקוח עבור הפריטים בהזמנה:</p><div class=\"grid2\">" + items(o).filter((it) => it.product_id).map((it) => { const sp = (D.priceMap[v.client_id] || {})[it.product_id]; return '<div class="field"><label for="pp-' + it.id + '">' + esc(it.name) + " (₪ ל" + unitLbl(it) + ')</label><input id="pp-' + it.id + '" data-pprod="' + it.product_id + '" inputmode="decimal" dir="ltr" value="' + esc(sp ?? "") + '" placeholder="אין שמור"></div>'; }).join("") + "</div>";
  }
  if (m.err) h += '<div class="err">' + esc(m.err) + "</div>";
  h += '<div class="mact"><button class="btn primary" data-act="m-save">' + (isNew ? "יצירת הזמנה" : "שמירה") + '</button><button class="btn" data-act="m-close">ביטול</button></div>';
  return h;
}
function syncForm() {
  const m = ui.modal; if (!m || m.type !== "form") return;
  const v = m.values;
  if (m.kind === "private") Object.assign(v, { customer_name: gv("f-name"), phone: gv("f-phone"), pickup: gv("f-type") === "pickup", delivery_date: gv("f-date"), time_window: gv("f-window"), city: gv("f-city"), street: gv("f-street"), building: gv("f-building"), entrance: gv("f-entrance"), floor: gv("f-floor"), apt: gv("f-apt") });
  else Object.assign(v, { client_id: gv("f-client") || null, delivery_date: gv("f-date"), pickup: gv("f-pick") === "1" });
  if (!m.id) m.rows.forEach((r, i) => { r.p = gv("r-p-" + i); r.a = gv("r-a-" + i); if (m.kind === "business") r.c = gv("r-c-" + i); });
}
function openForm(kind, id) {
  let values;
  if (id) {
    const o = byId(id);
    values = kind === "private" ? { customer_name: o.customer_name, phone: o.phone, pickup: o.pickup, delivery_date: o.delivery_date, time_window: o.time_window, ...(o.address || {}) } : { client_id: o.client_id, delivery_date: o.delivery_date, pickup: o.pickup };
  } else {
    if (kind === "business" && !D.clients.length) { toast("אין עדיין לקוחות עסקיים. הוסיפו לקוח בהגדרות."); return; }
    const d = nextDeliveryDay(TODAY(), { inclusive: true, holidays: holidays() });
    values = kind === "private" ? { pickup: false, delivery_date: d, time_window: "09:00-16:00", city: "תל אביב-יפו" } : { client_id: null, client_q: "", delivery_date: d, pickup: false };
  }
  ui.modal = { type: "form", kind, id, values, rows: [{}], wide: true };
  render();
}
const toNum = (s) => { const n = Number(String(s ?? "").replace(",", ".")); return String(s ?? "").trim() !== "" && Number.isFinite(n) ? n : null; };
async function saveForm() {
  syncForm();
  const m = ui.modal, v = m.values;
  const err = (t) => { m.err = t; render(); };
  const hol = holidays();
  if (hol.includes(v.delivery_date)) return err("היום הזה מסומן כחג או יום סגירה");
  if (m.kind === "private") {
    if (!v.customer_name) return err("חסר שם לקוח");
    if (!/^[0-9+\-\s]{9,}$/.test(v.phone)) return err("מספר טלפון לא תקין");
    if (!v.pickup && (!v.city || !v.street || !v.building)) return err("למשלוח צריך עיר, רחוב ומספר בניין");
  }
  if (m.kind === "business" && !v.client_id) return err("בחרו לקוח");
  if (!v.pickup && !isDeliveryDay(v.delivery_date, hol)) return err("ביום ראשון יש איסוף עצמי בלבד. סמנו איסוף עצמי או בחרו יום אחר");
  const address = m.kind === "private" && !v.pickup ? { city: v.city, street: v.street, building: v.building, entrance: v.entrance, floor: v.floor, apt: v.apt } : {};
  if (m.id) {
    const p = m.kind === "private" ? { customer_name: v.customer_name, phone: v.phone, pickup: v.pickup, delivery_date: v.delivery_date, time_window: v.time_window, address } : { client_id: v.client_id, delivery_date: v.delivery_date, pickup: v.pickup };
    const prices = [];
    document.querySelectorAll("[data-pprod]").forEach((el) => { const n = toNum(el.value); if (n != null && n > 0 && (D.priceMap[v.client_id] || {})[el.dataset.pprod] !== n) prices.push({ client_id: v.client_id, product_id: el.dataset.pprod, price: n, updated_by: "admin" }); });
    ui.modal = null;
    await act(async () => { await B.rpc("update_order", { p_order: m.id, p }); if (prices.length) await B.upsertClientPrices(prices); }, { okToast: "נשמר" });
    return;
  }
  const rows = m.rows.filter((r) => r.p);
  if (!rows.length) return err("הוסיפו לפחות מוצר אחד");
  for (const r of rows) { const p = D.productsById[r.p]; const n = toNum(r.a); if (n == null || n <= 0 || (p.unit === "unit" && !Number.isInteger(n))) return err("כמות לא תקינה עבור " + p.name); }
  const payload = { kind: m.kind, delivery_date: v.delivery_date, pickup: v.pickup, items: rows.map((r) => ({ product_id: r.p, amount: toNum(r.a), ...(m.kind === "business" && toNum(r.c) ? { price: toNum(r.c) } : {}) })) };
  if (m.kind === "private") Object.assign(payload, { customer_name: v.customer_name, phone: v.phone, time_window: v.time_window || null, address, delivery_fee: v.pickup ? 0 : 30 });
  else payload.client_id = v.client_id;
  ui.modal = null;
  let newId = null;
  const ok = await act(async () => { newId = await B.rpc("create_manual_order", { p: payload }); }, { okToast: "ההזמנה נוצרה" });
  if (ok && newId) { const o = byId(newId); if (o) { ui.dayOpen[o.kind + ":" + o.delivery_date] = true; ui.open.add(o.id); ui.scrollTo = o.id; render(); } }
  else if (!ok) { ui.modal = m; render(); }
}

/* ---------- CSV ---------- */
function csvRows(o, diffMode) {
  const c = o.kind === "business" ? client(o.client_id) : null;
  const base = {
    number: o.number, kind: o.kind === "private" ? "פרטי" : "עסקי", date: o.delivery_date, mode: o.pickup ? "איסוף עצמי" : "משלוח", window: o.time_window || "",
    name: c ? c.contact_name || "" : o.customer_name, business: c ? c.business_name : "", company: c ? [c.legal_name, c.company_number].filter(Boolean).join(" ") : "",
    phone: c ? c.phone || "" : o.phone, address: fullAddr(c ? c.address : o.address), status: STATUS[o.status], doc: o.morning_doc_number || "", odiff: orderDiff(o).toFixed(2),
  };
  return o.order_items.slice().sort((a, b) => a.position - b.position)
    .filter((it) => !diffMode || Math.abs(itemDiff(o, it)) >= 0.01)
    .filter((it) => !it.removed_at || o.kind === "private")
    .map((it) => {
      const p = unitPrice(o, it);
      return { ...base, item: it.name + (it.removed_at ? " (הוסר)" : it.added_during_packing ? " (נוסף)" : ""), option: it.option, note: it.note,
        ordered: it.added_during_packing ? "" : orderedAmount(it) ?? "", unit: unitLbl(it), final: it.removed_at ? 0 : it.confirmed ? it.final_amount : "",
        ppu: p == null ? "" : round2(p), diff: o.kind === "private" && (it.confirmed || it.removed_at) ? itemDiff(o, it).toFixed(2) : "" };
    });
}
async function runCSV() {
  const m = ui.modal;
  const cols = (m.mode === "diffs" ? DIFF_COLS : COLS).filter((c) => document.getElementById("col-" + c[0])?.checked).map((c) => ({ key: c[0], label: c[1] }));
  if (!cols.length) { m.err = "בחרו לפחות עמודה אחת"; render(); return; }
  let sections, name;
  if (m.mode === "diffs") { sections = [diffOrders().flatMap((o) => csvRows(o, true))]; name = "basta-price-differences-" + TODAY() + ".csv"; }
  else {
    const wantP = document.getElementById("x-private")?.checked, wantB = document.getElementById("x-business")?.checked;
    if (!wantP && !wantB) { m.err = "בחרו פרטיות, עסקיות או את שתיהן"; render(); return; }
    const sel = [...ui.selected].map(byId).filter(Boolean);
    sections = [];
    if (wantP) sections.push(sortDay(sel.filter((o) => o.kind === "private")).flatMap((o) => csvRows(o)));
    if (wantB) sections.push(sortDay(sel.filter((o) => o.kind === "business")).flatMap((o) => csvRows(o)));
    name = "basta-orders-" + TODAY() + ".csv";
  }
  const text = buildCsv(sections, cols);
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    ui.modal = null; toast("הקובץ ירד: " + name);
  } catch { ui.modal = { type: "csvtext", text: text.replace(/^﻿/, ""), wide: true }; render(); }
  window.__bastapack.lastCsv = text;
}

/* ---------- events ---------- */
function login(u, p) {
  ui.loginUser = u; ui.busy = true; ui.loginErr = ""; render();
  B.signIn(u, p).then(async (role) => { ui.role = role; ui.screen = "home"; await reload(); })
    .catch((e) => { ui.loginErr = e.message; ui.focusId = "lp"; })
    .finally(() => { ui.busy = false; render(); });
}
function logout() { B.signOut(); ui.role = null; ui.screen = "login"; ui.selectMode = false; ui.selected.clear(); ui.loaded = false; D = null; render(); }

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act_ = t.dataset.act;
  if (act_ === "scrim") { if (e.target === t) closeModal(); return; }
  const i = act_.indexOf(":");
  const a = i < 0 ? act_ : act_.slice(0, i), rest = i < 0 ? "" : act_.slice(i + 1);
  const [b, c] = rest.split(":");
  if (ui.busy && !a.startsWith("m-close")) return;
  switch (a) {
    case "logout": logout(); break;
    case "go": ui.screen = b; if (b === "home") ui.selectMode = false; if (b === "log") ui.log = null; window.scrollTo(0, 0); render(); break;
    case "day": { const key = rest.slice(b.length + 1); ui.dayOpen[b + ":" + key] = !dayIsOpen(b, key); render(); break; }
    case "toggle": if (ui.open.has(b)) ui.open.delete(b); else { ui.open.add(b); ui.opening = b; } render(); break;
    case "ok": confirmItem(b, c); break;
    case "pack": tryPack(b); break;
    case "edit": if (ui.editing.has(b)) ui.editing.delete(b); else { ui.editing.add(b); ui.open.add(b); } render(); break;
    case "rm": { const o = byId(b), it = o.order_items.find((x) => x.id === c); openConfirm({ title: "להסיר את " + it.name + "?", body: "הפריט יוסר מהזמנה " + o.number + ".", ok: "הסרה", danger: true, run: () => act(() => B.rpc("remove_item", { p_item: c }), { noteFor: b }) }); break; }
    case "add": addItem(b); break;
    case "pickup": { const o = byId(b); act(() => B.rpc("set_pickup", { p_order: b, p_pickup: !o.pickup }), { okToast: !o.pickup ? "סומן כאיסוף עצמי. ההזמנה הוצאה ממסלול המשלוח" : "ההזמנה חזרה למשלוח", noteFor: b }); break; }
    case "details": openForm(byId(b).kind, b); break;
    case "del": { const o = byId(b); openConfirm({ title: "למחוק את הזמנה " + o.number + "?", body: oName(o) + ". ההזמנה תעבור לסל המחזור ותישמר שם 30 יום.", ok: "מחיקה", danger: true, run: () => { ui.open.delete(b); ui.selected.delete(b); return act(() => B.rpc("delete_orders", { p_ids: [b] }), { okToast: "ההזמנה הועברה לסל המחזור" }); } }); break; }
    case "fire": ui.modal = { type: "fire", id: b }; render(); break;
    case "new": openForm(b); break;
    case "selmode": ui.selectMode = !ui.selectMode; if (!ui.selectMode) ui.selected.clear(); render(); break;
    case "sel": if (t.checked) ui.selected.add(b); else ui.selected.delete(b); render(); break;
    case "selday": { const key = rest.slice(b.length + 1); const g = sectionGroups(b).find((x) => x.key === key); if (g) g.orders.forEach((o) => (t.checked ? ui.selected.add(o.id) : ui.selected.delete(o.id))); render(); break; }
    case "selall": sectionGroups(b).forEach((g) => g.orders.forEach((o) => ui.selected.add(o.id))); render(); break;
    case "selclear": ui.selected.clear(); render(); break;
    case "bulkdel": {
      const sel = [...ui.selected].map(byId).filter(Boolean), fired = sel.filter(isFired), del = sel.filter((o) => !isFired(o));
      openConfirm({ title: "למחוק " + del.length + " הזמנות?", body: "ההזמנות יעברו לסל המחזור ויישמרו 30 יום." + (fired.length ? " " + fired.length + " הזמנות שהופקו במורנינג לא יימחקו." : ""), ok: "מחיקה", danger: true,
        run: () => act(async () => { const n = await B.rpc("delete_orders", { p_ids: del.map((o) => o.id) }); ui.selected.clear(); toast(n + " הזמנות הועברו לסל המחזור"); }) });
      break;
    }
    case "bulkcsv": { const sel = [...ui.selected].map(byId).filter(Boolean); ui.modal = { type: "csv", mode: "orders", wide: true, counts: { private: sel.filter((o) => o.kind === "private").length, business: sel.filter((o) => o.kind === "business").length } }; render(); break; }
    case "diffcsv": ui.modal = { type: "csv", mode: "diffs", wide: true }; render(); break;
    case "restore": act(() => B.rpc("restore_order", { p_order: b }), { okToast: "ההזמנה שוחזרה" }); break;
    case "dday": ui.deliverDay = b; render(); break;
    case "route-opt": routeCall(b, { action: "optimize" }, "המסלול סודר"); break;
    case "route-pdf": window.print(); break;
    case "mv": { const parts = rest.split(":"); moveStop(parts[0], parts[1], Number(parts[2])); break; }
    case "hol-add": { const d = gv("hol-d"); if (!d) { toast("בחרו תאריך"); break; } act(() => B.addHoliday(d, gv("hol-n")), { okToast: "נוסף" }); break; }
    case "hol-del": act(() => B.removeHoliday(rest), { okToast: "הוסר" }); break;
    case "route": act(() => B.setSetting("route_end", b), { okToast: "נשמר" }); break;
    case "end-addr-save": { const v = gv("end-addr"); if (!v) { toast("הזינו כתובת"); break; } act(() => B.setSetting("route_end_address", v), { okToast: "כתובת הסיום נשמרה" }); break; }
    case "client-add": {
      const name = gv("cl-b"); if (!name) { toast("חסר שם העסק"); break; }
      const st = gv("cl-st"), m = st.match(/^(.*?)\s+(\d+\S*)$/);
      act(() => B.addClient({ business_name: name, contact_name: gv("cl-c") || null, phone: gv("cl-p") || null, legal_name: gv("cl-l") || null, company_number: gv("cl-h") || null,
        address: { city: gv("cl-city"), street: m ? m[1] : st, building: m ? m[2] : "" } }), { okToast: "הלקוח נוסף" });
      break;
    }
    case "prices": ui.modal = { type: "prices", cid: b, wide: true }; render(); break;
    case "m-fire": {
      const m = ui.modal, id = m.id; ui.busy = true; m.err = null; render();
      B.morning({ action: "fire", order_id: id })
        .then(async (r) => { ui.modal = null; await reload(); toast("תעודת משלוח " + (r.number || "") + " נוצרה במורנינג"); })
        .catch((e) => { if (ui.modal) ui.modal.err = e.message; })
        .finally(() => { ui.busy = false; render(); });
      break;
    }
    case "morning-test": act(async () => { const r = await B.morning({ action: "test" }); toast(r.sandbox ? "החיבור למורנינג (סביבת ניסיון) תקין" : "החיבור למורנינג תקין"); }); break;
    case "morning-sync": act(async () => { const r = await B.morning({ action: "sync_clients" }); toast("סונכרנו " + r.total + " לקוחות (" + r.added + " חדשים)"); }); break;
    case "pick-client": syncForm(); ui.modal.values.client_id = b; ui.modal.values.client_q = ""; render(); break;
    case "client-clear": syncForm(); ui.modal.values.client_id = null; ui.focusId = "f-client-q"; render(); break;
    case "review-done": act(() => B.rpc("mark_email_handled", { p_id: b }), { okToast: "סומן כטופל" }); break;
    case "review-create": openFormFromEmail(b); break;
    case "prod-add": {
      const n = gv("pr-n"); if (!n) { toast("חסר שם המוצר"); break; }
      act(() => B.addProduct({ name: n, unit: gv("pr-u") || "kg", site_price: toNum(gv("pr-p")) }), { okToast: "המוצר נוסף" });
      break;
    }
    case "prod-toggle": { const p = D.productsById[b]; act(() => B.updateProduct(b, { active: !p.active })); break; }
    case "m-close": closeModal(); break;
    case "m-ok": { const run = modalRun; ui.modal = null; modalRun = null; render(); if (run) run(); break; }
    case "m-csv": runCSV(); break;
    case "m-copy": { const ta = document.getElementById("csvtext"); try { navigator.clipboard.writeText(ta.value).then(() => toast("הועתק"), () => { ta.select(); toast("סמנו והעתיקו ידנית"); }); } catch { ta.select(); } break; }
    case "m-prices": {
      const m = ui.modal, rows = [];
      for (const el of document.querySelectorAll("[data-cprice]")) {
        const raw = el.value.trim(); if (!raw) continue;
        const n = toNum(raw); if (n == null || n <= 0) { m.err = "מחיר לא תקין: " + D.productsById[el.dataset.cprice].name; render(); return; }
        if ((D.priceMap[m.cid] || {})[el.dataset.cprice] !== n) rows.push({ client_id: m.cid, product_id: el.dataset.cprice, price: n, updated_by: "admin" });
      }
      ui.modal = null;
      if (rows.length) act(() => B.upsertClientPrices(rows), { okToast: "המחירון נשמר" }); else render();
      break;
    }
    case "m-save": saveForm(); break;
    case "m-addrow": syncForm(); ui.modal.rows.push({}); render(); break;
    case "m-rmrow": syncForm(); ui.modal.rows.splice(Number(b), 1); if (!ui.modal.rows.length) ui.modal.rows.push({}); render(); break;
  }
});
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.key) { ui.drafts[el.dataset.key] = el.value; delete ui.errs[el.dataset.key]; }
  if (el.dataset.adda) (ui.adding[el.dataset.adda] ||= {}).a = el.value;
  if (el.dataset.search === "clients") { ui.clientQ = el.value; render(); }
  if (el.dataset.search === "formclient" && ui.modal) { syncForm(); ui.modal.values.client_q = el.value; render(); }
});
document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset.addp) { (ui.adding[el.dataset.addp] ||= {}).p = el.value; render(); }
  if (el.dataset.row != null && ui.modal?.type === "form") { syncForm(); render(); }
  if (el.id === "f-client" && ui.modal && !ui.modal.id) { syncForm(); render(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ui.modal) { closeModal(); return; }
  const el = e.target;
  if (e.key === "Enter" && el.dataset?.key) { e.preventDefault(); const [o, i] = el.dataset.key.split(":"); confirmItem(o, i); }
  if (e.key === "Enter" && el.dataset?.adda) { e.preventDefault(); addItem(el.dataset.adda); }
});
document.addEventListener("submit", (e) => {
  if (e.target.id !== "loginForm") return;
  e.preventDefault();
  login(gv("lu"), document.getElementById("lp").value);
});

/* ---------- start ---------- */
// Pick up changes made on other devices. Skipped while a form is open so nothing typed is lost.
setInterval(async () => {
  if (!ui.role || document.hidden || ui.modal || ui.busy) return;
  await reload(); if (!ui.modal && !ui.busy) render();
}, REFRESH_MS);
document.addEventListener("visibilitychange", async () => { if (!document.hidden && ui.role) { await reload(); render(); } });

(async () => {
  const role = await B.restore();
  if (role) { ui.role = role; ui.screen = "home"; await reload(); }
  else ui.screen = "login";
  render();
})();
