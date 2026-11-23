// The WhatsApp assistant's brain. No network code here: everything it touches comes in through `deps`,
// so it can be tested in Node with fakes (tests/assistant.test.mjs) and run in Deno (functions/whatsapp).
//
// deps = {
//   store: { isAllowed(phone), isOwner(phone), saveIncoming(msg) → bool (false = already handled),
//            saveOutgoing(phone, text), history(phone, n), getPending(phone), setPending(phone, p), clearPending(phone),
//            findClients(q), findProducts(q), clientPrices(clientId), listOrders(filter), getOrder(number),
//            rpc(name, args), addAllowed(phone, name), removeAllowed(phone), createIssue(title, body) },
//   claude(body) → Anthropic Messages API response,
//   send(phone, text),
//   today() → "YYYY-MM-DD" in Israel,
//   model?: string
// }
// Risky actions (cancel, changing a saved price, allowed numbers, app changes) are never done straight away:
// the tool stores them as pending and the sender must reply YES / כן. The YES is checked here in code,
// not by the AI, so a misunderstanding cannot cancel an order.

const DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const YES = /^(yes|y|ok|כן|אישור|מאשר|מאשרת|בטח|יאללה)$/i;
const NO = /^(no|n|לא|ביטול|בטל|עזוב)$/i;
const clean = (t) => String(t || "").trim().replace(/[.!?,\s]+$/g, "").replace(/^\s+/, "");

export function systemPrompt(today) {
  const d = new Date(today + "T12:00:00Z");
  const lines = [];
  for (let i = 0; i < 8; i++) { const x = new Date(d); x.setUTCDate(d.getUTCDate() + i); lines.push(DAYS[x.getUTCDay()] + " " + x.toISOString().slice(0, 10)); }
  return `את/ה העוזר בוואטסאפ של "בסטה דגים", חנות דגים בתל אביב (מקווה ישראל 22). מדברים איתך עומר (הבעלים) ואנשי צוות שהוא אישר.
היום: ${DAYS[d.getUTCDay()]} ${today}. הימים הקרובים: ${lines.join(" · ")}.

מה את/ה עושה:
- יוצר/ת הזמנות עסקיות (למסעדות) מהודעות כמו "2 ק״ג סלמון לברוס למחר" או מהודעה מועברת של מסעדה.
- עונה על שאלות על הזמנות ועל האפליקציה, מעדכן/ת ומבטל/ת הזמנות, מנהל/ת מחירונים ללקוחות.

כללים:
- ימי עבודה: ב׳–ו׳ משלוחים ואיסוף. ראשון: איסוף עצמי בלבד. שבת: סגור.
- אם לא נאמר יום, תמיד לשאול לאיזה יום. לא לנחש.
- לקוח: לחפש עם find_clients. אם יש כמה התאמות או אף אחת, לשאול ("לא מצאתי את ברוס במורנינג, אולי ברוס בורגר בע״מ?"). כשמתברר כינוי חדש ללקוח, לשמור אותו עם add_alias.
- מוצרים: לחפש עם find_products ולהשתמש רק במוצרים שקיימים. כמות בק״ג למוצרי משקל, ביחידות למוצרי יחידה.
- מחירים: לפני מע״מ, לק״ג או ליחידה. אם ללקוח אין מחיר שמור למוצר, create_order יחזיר אילו מחירים חסרים: לשאול את המחיר ולשמור עם set_price, ואז ליצור. אם אומרים "אחר כך", ליצור עם allow_missing_prices.
- אחרי יצירה או עדכון: לאשר במלואו: מספר הזמנה, לקוח, יום ותאריך, פריטים וכמויות, משלוח או איסוף.
- פעולות שדורשות אישור (ביטול הזמנה, שינוי מחיר קיים, הוספה/הסרה של מספר מורשה, שינוי באפליקציה): הכלי שומר אותן וממתין. לכתוב בדיוק מה יקרה ולבקש להשיב "כן" לאישור. אל תכתוב/י שהפעולה בוצעה לפני האישור.
- הפקה במורנינג (FIRE) ושינוי סיסמאות נעשים באפליקציה בלבד.
- בקשה לשינוי או תיקון באפליקציה עצמה: לנסח אותה בבירור ולקרוא ל-request_app_change.
- תשובות קצרות, בעברית, בסגנון וואטסאפ. אפשר *הדגשה*. בלי טבלאות.`;
}

export const TOOLS = [
  { name: "find_clients", description: "מחפש לקוחות עסקיים לפי שם, כינוי, ח.פ. או טלפון. מחזיר עד 8 התאמות.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "find_products", description: "מחפש מוצרים בקטלוג לפי חלק מהשם. מחזיר id, שם ויחידה (kg/unit).", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_client_prices", description: "המחירון השמור של לקוח (₪ לפני מע״מ, לק״ג/ליחידה).", input_schema: { type: "object", properties: { client_id: { type: "string" } }, required: ["client_id"] } },
  { name: "list_orders", description: "רשימת הזמנות פתוחות. סינון לפי תאריך (YYYY-MM-DD), סוג (private/business) וסטטוס (new/packed/fired).", input_schema: { type: "object", properties: { date: { type: "string" }, kind: { type: "string", enum: ["private", "business"] }, status: { type: "string", enum: ["new", "packed", "fired"] } } } },
  { name: "get_order", description: "פרטי הזמנה לפי מספר (למשל B-1043 או 981).", input_schema: { type: "object", properties: { number: { type: "string" } }, required: ["number"] } },
  { name: "create_order", description: "יוצר הזמנה עסקית.", input_schema: { type: "object", properties: {
    client_id: { type: "string" }, delivery_date: { type: "string", description: "YYYY-MM-DD" }, pickup: { type: "boolean" },
    items: { type: "array", items: { type: "object", properties: { product_id: { type: "string" }, amount: { type: "number" } }, required: ["product_id", "amount"] } },
    note: { type: "string" }, allow_missing_prices: { type: "boolean" } }, required: ["client_id", "delivery_date", "items"] } },
  { name: "update_order", description: "משנה הזמנה עסקית: תאריך, איסוף עצמי, או רשימת פריטים חדשה במקום הקיימת (רק לפני שהתחילו לארוז).", input_schema: { type: "object", properties: {
    number: { type: "string" }, delivery_date: { type: "string" }, pickup: { type: "boolean" },
    items: { type: "array", items: { type: "object", properties: { product_id: { type: "string" }, amount: { type: "number" } }, required: ["product_id", "amount"] } } }, required: ["number"] } },
  { name: "cancel_order", description: "מבקש לבטל הזמנה. דורש אישור \"כן\" מהשולח.", input_schema: { type: "object", properties: { number: { type: "string" } }, required: ["number"] } },
  { name: "set_price", description: "שומר מחיר ללקוח למוצר. מחיר חדש נשמר מיד; שינוי מחיר קיים דורש אישור \"כן\".", input_schema: { type: "object", properties: { client_id: { type: "string" }, product_id: { type: "string" }, price: { type: "number" } }, required: ["client_id", "product_id", "price"] } },
  { name: "add_alias", description: "שומר כינוי ללקוח (למשל \"ברוס\") כדי לזהות אותו בהמשך.", input_schema: { type: "object", properties: { client_id: { type: "string" }, alias: { type: "string" } }, required: ["client_id", "alias"] } },
  { name: "manage_allowed_number", description: "מוסיף או מסיר מספר שמורשה לדבר עם העוזר. רק הבעלים. דורש אישור \"כן\".", input_schema: { type: "object", properties: { action: { type: "string", enum: ["add", "remove"] }, phone: { type: "string", description: "למשל 0521234567 או +972521234567" }, name: { type: "string" } }, required: ["action", "phone"] } },
  { name: "request_app_change", description: "בקשה לשנות או לתקן משהו באפליקציה. דורש אישור \"כן\".", input_schema: { type: "object", properties: { title: { type: "string" }, details: { type: "string" } }, required: ["title", "details"] } },
];

export function normalizePhone(p) {
  const d = String(p || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  if (d.startsWith("972")) return "+" + d;
  if (d.startsWith("0")) return "+972" + d.slice(1);
  return "+" + d;
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

async function runTool(deps, phone, name, input) {
  const s = deps.store;
  switch (name) {
    case "find_clients": return (await s.findClients(String(input.query || ""))).slice(0, 8);
    case "find_products": return (await s.findProducts(String(input.query || ""))).slice(0, 10);
    case "get_client_prices": return await s.clientPrices(input.client_id);
    case "list_orders": return await s.listOrders({ date: isDate(input.date) ? input.date : null, kind: input.kind || null, status: input.status || null });
    case "get_order": return (await s.getOrder(String(input.number || "").trim())) || { error: "הזמנה לא נמצאה" };
    case "create_order": {
      if (!isDate(input.delivery_date)) return { error: "חסר תאריך תקין" };
      if (!input.allow_missing_prices) {
        const prices = await s.clientPrices(input.client_id);
        const have = new Set(prices.map((p) => p.product_id));
        const missing = (input.items || []).filter((i) => !have.has(i.product_id)).map((i) => i.product_id);
        if (missing.length) {
          const names = (await s.findProducts("")).filter((p) => missing.includes(p.id)).map((p) => p.name);
          return { error: "missing_prices", missing_products: names.length ? names : missing, hint: "לשאול את המחיר, לשמור עם set_price, ואז ליצור שוב" };
        }
      }
      return await s.rpc("wa_create_order", { p_client: input.client_id, p_date: input.delivery_date, p_pickup: !!input.pickup, p_items: input.items || [], p_note: input.note || null });
    }
    case "update_order": {
      const p = {};
      if (input.delivery_date) { if (!isDate(input.delivery_date)) return { error: "תאריך לא תקין" }; p.delivery_date = input.delivery_date; }
      if (typeof input.pickup === "boolean") p.pickup = input.pickup;
      if (Array.isArray(input.items)) p.items = input.items;
      return await s.rpc("wa_update_order", { p_number: input.number, p });
    }
    case "cancel_order": {
      const o = await s.getOrder(String(input.number || "").trim());
      if (!o) return { error: "הזמנה לא נמצאה" };
      const summary = "ביטול הזמנה " + o.number + " (" + (o.client || o.customer || "") + ", " + o.date + ")";
      await s.setPending(phone, { action: "cancel_order", args: { number: o.number }, summary });
      return { needs_confirmation: true, summary };
    }
    case "set_price": {
      const price = Number(input.price);
      if (!(price > 0)) return { error: "מחיר לא תקין" };
      const current = (await s.clientPrices(input.client_id)).find((p) => p.product_id === input.product_id);
      if (!current) { await s.rpc("wa_set_price", { p_client: input.client_id, p_product: input.product_id, p_price: price }); return { saved: true, price }; }
      if (Number(current.price) === price) return { saved: true, unchanged: true, price };
      const summary = "שינוי מחיר " + (current.product || "") + " ללקוח: ₪" + current.price + " ← ₪" + price;
      await s.setPending(phone, { action: "set_price", args: { client_id: input.client_id, product_id: input.product_id, price }, summary });
      return { needs_confirmation: true, summary, old_price: Number(current.price), new_price: price };
    }
    case "add_alias": await s.rpc("wa_add_alias", { p_client: input.client_id, p_alias: String(input.alias || "") }); return { saved: true };
    case "manage_allowed_number": {
      if (!(await s.isOwner(phone))) return { error: "רק הבעלים יכול לשנות את רשימת המספרים" };
      const target = normalizePhone(input.phone);
      if (!/^\+\d{10,15}$/.test(target)) return { error: "מספר לא תקין" };
      if (input.action === "remove" && target === phone) return { error: "אי אפשר להסיר את המספר של הבעלים" };
      const summary = (input.action === "add" ? "הוספת " : "הסרת ") + target + (input.name ? " (" + input.name + ")" : "") + " לרשימת המספרים המורשים";
      await s.setPending(phone, { action: "allowed_" + input.action, args: { phone: target, name: input.name || "" }, summary });
      return { needs_confirmation: true, summary };
    }
    case "request_app_change": {
      const summary = "שינוי באפליקציה: " + input.title;
      await s.setPending(phone, { action: "app_change", args: { title: String(input.title), details: String(input.details) }, summary });
      return { needs_confirmation: true, summary };
    }
  }
  return { error: "כלי לא מוכר" };
}

async function runPending(deps, phone, p) {
  const s = deps.store;
  switch (p.action) {
    case "cancel_order": await s.rpc("wa_cancel_order", { p_number: p.args.number }); return "✅ הזמנה " + p.args.number + " בוטלה. אפשר לשחזר אותה מסל המחזור באפליקציה.";
    case "set_price": await s.rpc("wa_set_price", { p_client: p.args.client_id, p_product: p.args.product_id, p_price: p.args.price }); return "✅ המחיר עודכן ל-₪" + p.args.price + ".";
    case "allowed_add": await s.addAllowed(p.args.phone, p.args.name); return "✅ " + p.args.phone + " נוסף. מעכשיו העוזר יענה לו.";
    case "allowed_remove": await s.removeAllowed(p.args.phone); return "✅ " + p.args.phone + " הוסר.";
    case "app_change": {
      const url = await s.createIssue(p.args.title, p.args.details + "\n\n(התבקש בוואטסאפ על ידי " + phone + ")");
      return "✅ הבקשה נרשמה" + (url ? ": " + url : "") + ". אעדכן כשהשינוי יהיה מוכן.";
    }
  }
  return "לא הצלחתי לבצע את הפעולה.";
}

/** Handles one incoming text message. Returns the reply sent (or null when nothing was sent). */
export async function handleMessage(deps, { id, phone, text }) {
  const s = deps.store;
  phone = normalizePhone(phone);
  if (!(await s.isAllowed(phone))) return null;
  if (!(await s.saveIncoming({ id, phone, body: text }))) return null; // WhatsApp sent it twice
  const reply = async (t) => { await deps.send(phone, t); await s.saveOutgoing(phone, t); return t; };

  const pending = await s.getPending(phone);
  if (pending) {
    const fresh = Date.now() - Date.parse(pending.created_at || 0) < 30 * 60_000;
    if (YES.test(clean(text))) {
      await s.clearPending(phone);
      if (!fresh) return reply("עבר יותר מחצי שעה, אז לא ביצעתי. בקשו שוב ואשאל לאישור מחדש.");
      try { return reply(await runPending(deps, phone, pending)); }
      catch (e) { return reply("❌ לא בוצע: " + (e.message || "שגיאה")); }
    }
    await s.clearPending(phone);
    if (NO.test(clean(text))) return reply("בסדר, לא בוצע.");
  }

  const msgs = [];
  for (const m of await s.history(phone, 16)) {
    const role = m.direction === "in" ? "user" : "assistant";
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += "\n" + m.body;
    else msgs.push({ role, content: m.body });
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") msgs.push({ role: "user", content: text });

  const system = systemPrompt(deps.today());
  for (let turn = 0; turn < 8; turn++) {
    const res = await deps.claude({ model: deps.model || "claude-sonnet-5-5", max_tokens: 1200, system, tools: TOOLS, messages: msgs });
    msgs.push({ role: "assistant", content: res.content });
    const uses = (res.content || []).filter((b) => b.type === "tool_use");
    if (!uses.length || res.stop_reason !== "tool_use") {
      const out = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      return out ? reply(out) : null;
    }
    const results = [];
    for (const u of uses) {
      let out;
      try { out = await runTool(deps, phone, u.name, u.input || {}); } catch (e) { out = { error: e.message || "שגיאה" }; }
      results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out ?? null) });
    }
    msgs.push({ role: "user", content: results });
  }
  return reply("מצטער, משהו השתבש. נסו לנסח שוב.");
}
