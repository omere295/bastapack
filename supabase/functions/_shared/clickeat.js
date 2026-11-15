// Reads a ClickEat order email (the HTML that arrives from noreply@click-eat.co.il) into an order.
// The layout is fixed, so it is read table by table; anything unexpected is reported as a problem
// instead of guessed. Payment details (card digits) are never read.
// Runs in Node (tests) and Deno (Supabase Edge Functions); no dependencies.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const text = (html) =>
  html.replace(/<br\s*\/?>/gi, " ").replace(/<\/li>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? m)
    .replace(/[‎‏]/g, "").replace(/[ \t\r]+/g, " ").replace(/ *\n */g, "\n").trim();

function tables(html) {
  const out = [];
  for (const t of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [];
    for (const r of t[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      rows.push([...r[1].matchAll(/<t([hd])[^>]*>([\s\S]*?)<\/t\1>/gi)].map((c) => text(c[2])));
    }
    out.push(rows);
  }
  return out;
}

const num = (s) => { const n = Number(String(s ?? "").replace(/[^\d.\-]/g, "")); return String(s ?? "").trim() !== "" && Number.isFinite(n) ? n : null; };
const headerIs = (rows, first) => rows.length && rows[0][0] === first;

/** Returns {order, problems}. order is null when the email is not a ClickEat order at all. */
export function parseClickEatOrder(html) {
  const problems = [];
  const ts = tables(html || "");
  const head = ts.find((r) => r[0] && r[0][0] === "מספר הזמנה:");
  if (!head) return { order: null, problems: ["המייל לא נראה כמו הזמנה מהאתר"] };

  const order = { number: head[0][1], delivery_date: null, time_window: null, customer_name: null, phone: null,
    pickup: null, address: {}, items: [], delivery_fee: 0, discount: 0, total: null };

  const dateRow = head[1] || [];
  const dm = (dateRow[0] || "").match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dm) order.delivery_date = dm[3] + "-" + dm[2].padStart(2, "0") + "-" + dm[1].padStart(2, "0");
  else problems.push("לא נמצא תאריך משלוח/איסוף");
  order.time_window = (dateRow[1] || "").replace(/\s/g, "") || null;

  const cust = ts.find((r) => headerIs(r, "שם"));
  if (cust && cust[1]) {
    const col = (name) => cust[0].indexOf(name);
    order.customer_name = cust[1][col("שם")] || null;
    order.phone = cust[1][col("טלפון")] || null;
    const type = cust[1][col("סוג הזמנה")];
    if (type === "משלוח") order.pickup = false;
    else if (type === "לקחת") order.pickup = true;
    else problems.push("סוג הזמנה לא מוכר: " + (type || "ריק"));
  } else problems.push("לא נמצאו פרטי לקוח");

  const addr = ts.find((r) => headerIs(r, "עיר"));
  if (addr && addr[1]) {
    const keys = { "עיר": "city", "רחוב": "street", "בניין": "building", "כניסה": "entrance", "קומה": "floor", "דירה": "apt" };
    addr[0].forEach((h, i) => { if (keys[h] && addr[1][i]) order.address[keys[h]] = addr[1][i]; });
  }
  if (order.pickup === false && !(order.address.city && order.address.street)) problems.push("הזמנת משלוח בלי כתובת מלאה");

  const itemsT = ts.find((r) => r[0] && r[0].includes("שם הפריט"));
  if (itemsT) {
    const h = itemsT[0], c = (name) => h.findIndex((x) => x.startsWith(name));
    const iQty = c("כמות"), iName = c("שם הפריט"), iPrice = c("מחיר"), iKg = c("משקל"), iNote = c("הערה"), iOpt = c("תת פריט");
    for (const r of itemsT.slice(1)) {
      if (r[0] === "סה״כ" || r[0] === 'סה"כ') continue;
      const name = (r[iName] || "").trim();
      if (!name) continue;
      const options = (r[iOpt] || "").split("\n").map((s) => s.trim()).filter(Boolean)
        .map((s) => (s.includes(":") ? s.slice(s.lastIndexOf(":") + 1).trim() : s));
      const item = { name, count: num(r[iQty]), price: num(r[iPrice]), kg: num(r[iKg]), note: (r[iNote] || "").trim(), option: options.join(", ") };
      if (item.count == null || item.count <= 0) problems.push("כמות לא תקינה לפריט " + name);
      if (item.price == null) problems.push("חסר מחיר לפריט " + name);
      order.items.push(item);
    }
  }
  if (!order.items.length) problems.push("לא נמצאו פריטים");

  const totals = ts.find((r) => r.some((row) => row[0] === "סה״כ תשלום"));
  if (totals) for (const [k, v] of totals) {
    if (k === "דמי משלוח") order.delivery_fee = num(v) ?? 0;
    if (k === "סה״כ הנחה") order.discount = Math.abs(num(v) ?? 0);
    if (k === "סה״כ תשלום") order.total = num(v);
  }
  if (order.total != null && order.items.length) {
    const sum = order.items.reduce((s, i) => s + (i.price || 0), 0) + order.delivery_fee - order.discount;
    if (Math.abs(sum - order.total) > 0.05) problems.push("סכום הפריטים (" + sum.toFixed(2) + ") לא תואם לסה״כ (" + order.total + ")");
  }
  if (!order.customer_name) problems.push("חסר שם לקוח");
  if (!order.phone) problems.push("חסר טלפון");
  return { order, problems };
}

/** Drops the payment table (card digits) from the HTML before it is kept for review. */
export function withoutPayments(html) {
  return String(html || "").replace(/<h3>\s*תשלומים:?\s*<\/h3>[\s\S]*?<\/table>/i, "").replace(/<img[^>]*>/gi, "");
}
