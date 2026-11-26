// The WhatsApp assistant's brain. No network code here: everything it touches comes in through `deps`,
// so it can be tested in Node with fakes (tests/assistant.test.mjs) and run in Deno (functions/whatsapp).
//
// deps = {
//   store: { isAllowed(phone), isOwner(phone), saveIncoming(msg) → bool (false = already handled),
//            saveOutgoing(phone, text), history(phone, n), getPending(phone), setPending(phone, p), clearPending(phone),
//            findClients(q), getClient(id) → {id, name, price_mode}, findProducts(q), clientPrices(clientId), listOrders(filter), getOrder(number),
//            memory() → [{id, fact, client}], remember({fact, client_id, phone}) → id, forget(id) → bool,
//            pastPrices(clientId) → {documents, prices: [{product_id, name, unit, price, regular, date}]} (from morning),
//            rpc(name, args), addAllowed(phone, name), removeAllowed(phone), createIssue(title, body) },
//   claude(body) → Anthropic Messages API response,
//   send(phone, text),
//   today() → "YYYY-MM-DD" in Israel,
//   model?: string,
//   typing?(messageId)  → marks the message read and shows "typing…" in WhatsApp while Emily works
// }
// Risky actions (cancel, changing a saved price, allowed numbers, app changes) are never done straight away:
// the tool stores them as pending and the sender must reply YES / כן. The YES is checked here in code,
// not by the AI, so a misunderstanding cannot cancel an order.

const DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const YES = /^(yes|y|ok|כן|אישור|מאשר|מאשרת|בטח|יאללה)$/i;
const NO = /^(no|n|לא|ביטול|בטל|עזוב)$/i;
const clean = (t) => String(t || "").trim().replace(/[.!?,\s]+$/g, "").replace(/^\s+/, "");

export function systemPrompt(today, catalog = [], memory = [], opts = {}) {
  const d = new Date(today + "T12:00:00Z");
  const lines = [];
  for (let i = 0; i < 8; i++) { const x = new Date(d); x.setUTCDate(d.getUTCDate() + i); lines.push(DAYS[x.getUTCDay()] + " " + x.toISOString().slice(0, 10)); }
  return `את אמילי (Emily), העוזרת בוואטסאפ של "בסטה דגים", חנות דגים בתל אביב (מקווה ישראל 22). מדברים איתך עומר (הבעלים) ואנשי צוות שהוא אישר.
היום: ${DAYS[d.getUTCDay()]} ${today}. הימים הקרובים: ${lines.join(" · ")}.

מה את עושה:
- יוצרת הזמנות עסקיות (למסעדות) מהודעות כמו "2 ק״ג סלמון לברוס למחר" או מהודעה מועברת של מסעדה.
- עונה על שאלות על הזמנות ועל האפליקציה, מעדכנת ומבטלת הזמנות, מנהלת מחירונים ללקוחות.

כללים:
- ימי עבודה: ב׳–ו׳ משלוחים ואיסוף. ראשון: איסוף עצמי בלבד. שבת: סגור.
- אם לא נאמר יום, תמיד לשאול לאיזה יום. לא לנחש.
- לקוח: לחפש עם find_clients. אם יש כמה התאמות או אף אחת, לשאול ("לא מצאתי את ברוס במורנינג, אולי ברוס בורגר בע״מ?"). כשמתברר כינוי חדש ללקוח, לשמור אותו עם add_alias.
- מוצרים: רק מהקטלוג העסקי (הפריטים במורנינג). אפשר לזהות מוצר גם לפי מק״ט. אם מוצר לא קיים בקטלוג, לא להמציא: להציע את הקרובים או לבקש להוסיף אותו במורנינג ולסנכרן. כמות בק״ג למוצרי משקל, ביחידות למוצרי יחידה. מוצר במשקל שהוזמן ביחידות ("2 יח׳ פילה סלמון"): amount = מספר היחידות עם pieces=true, ושוקלים באריזה. הוראות לפריט ("לפלט", "להביא ראש ואידרה") נכנסות ל-note של אותו פריט.
- מחירים: לפני מע״מ, לק״ג או ליחידה. create_order מסדר את המחירים לבד ולא עוצר הזמנה בגלל מחיר: מחיר שמור של הלקוח; לקוח חדש בלי מחירון מקבל את המחירים האחרונים ששילם במורנינג (ואם אין לו מסמכים, המחיר הרגיל); פריט בלי מחיר שלו מקבל את מה ששילם בפעם האחרונה או את המחיר הרגיל. *לא לשאול על מחירים.* אם create_order מחזיר price_notes, לציין אותן בקצרה.
- רק כשהבעלים מבקש: set_price לשינוי מחיר, set_price_mode כדי לקבוע שלקוח על מחירים רגילים (regular) או מיוחדים (special), past_prices כדי לראות מה לקוח שילם במורנינג.
- שאלות: לשאול רק שאלה קריטית, שבלעדיה אי אפשר לפתוח את ההזמנה: לקוח שלא נמצא או שמתאימים לו כמה לקוחות, מוצר שאי אפשר לזהות, אין שום יום. שאלה אחת בכל פעם, קצרה. כל השאר להחליט לבד בהיגיון ולציין בקצרה: כמות בק״ג למוצר שנמכר ביחידות → amount = הערכת מספר יחידות (לפחות 1) ו-note עם מה שביקשו ("ביקשו 1.5 ק״ג"); מוצר במשקל שהוזמן ביחידות → pieces; גודל, טווח משקל או הוראת הכנה → note של הפריט; משלוח אלא אם כתוב איסוף.
- זיכרון קבוע: כשמלמדים אותך משהו שצריך לזכור תמיד (כלל עבודה, העדפה או פרט קבוע על לקוח), לשמור עם remember ולכתוב "אזכור: …". כשמבקשים לשנות או לשכוח משהו שזכרת, forget לישן ו-remember לחדש אם צריך. מחירים, כינויים וסוג מחירון נשמרים בכלים שלהם ולא בזיכרון. הוראה להזמנה אחת לא לזכור.
- אחרי יצירה: לענות בקצרה, שורה אחת: "בוצע ✅ B-1050 · לקוח · יום · פריטים" (ומה שהנחת, בסוגריים). אחרי עדכון: אותו דבר עם "עודכן". פונים לשולח בלשון זכר, אלא אם ידוע אחרת.
- פעולות שדורשות אישור (ביטול הזמנה, שינוי מחיר קיים, הוספה/הסרה של מספר מורשה, שינוי באפליקציה): הכלי שומר אותן וממתין. לכתוב בדיוק מה יקרה ולבקש להשיב "כן" לאישור. אל תכתבי שהפעולה בוצעה לפני האישור.
- הפקה במורנינג (FIRE) ושינוי סיסמאות נעשים באפליקציה בלבד.
- בקשה לשינוי או תיקון באפליקציה עצמה: לנסח אותה בבירור ולקרוא ל-request_app_change.
- כשמציגים את עצמך או שואלים מי את: "אמילי, העוזרת של בסטה דגים". מדברים עלייך בלשון נקבה.
- כשצריך כמה חיפושים או פעולות שלא תלויים זה בזה (למשל כמה לקוחות או כמה הזמנות בהודעה אחת), להפעיל את כל הכלים באותו תור, ביחד.
- תשובות קצרות, בעברית, בסגנון וואטסאפ. אפשר *הדגשה*. בלי טבלאות.` +
    (catalog.length ? "\n\nקטלוג המוצרים העסקיים (id · שם · יחידה · מק״ט · מחיר רגיל לפני מע״מ). להשתמש ב-id מכאן ישירות, בלי find_products:\n" + catalog.map((p) => p.id + " · " + p.name + " · " + (p.unit === "unit" ? "יחידה" : "ק״ג") + (p.sku ? " · " + p.sku : "") + (p.list_price != null ? " · ₪" + Number(p.list_price) : "")).join("\n")
      : "\n\nהקטלוג העסקי עדיין ריק: אי אפשר ליצור הזמנות עד שמנהל לוחץ באפליקציה על הגדרות → \"סנכרון מוצרים ממורנינג\". להסביר את זה אם מבקשים הזמנה.") +
    (memory.length ? "\n\nדברים שלימדו אותך (לפעול לפיהם תמיד, אלא אם ביקשו עכשיו אחרת). [id] בשביל forget:\n" + memory.map((m) => "[" + m.id + "] " + (m.client ? "(" + m.client + ") " : "") + m.fact).join("\n") : "") +
    (opts.batch ? "\n\n*מצב כמה הזמנות:* ההודעה היא הזמנה אחת מתוך הודעה עם כמה הזמנות. התשובה שלך לא נשלחת, היא נאספת לסיכום אחד. לעבוד רק על ההזמנה הזו ולפתוח אותה עם create_order בלי שאלות לא קריטיות. אחרי שנפתחה, לענות בשורה אחת בלבד: \"B-1050 · לקוח · פריטים\" (ומה שהנחת או הערות מחיר, בסוגריים קצרים). אם יש שאלה קריטית ואי אפשר לפתוח, לא לפתוח, ולענות רק בשאלה אחת קצרה שמתחילה בשם הלקוח כפי שנכתב, בלי הקדמות." : "") +
    (opts.question ? "\n\n*שאלה פתוחה* (שאלת על הזמנה מתוך הודעה עם כמה הזמנות, ומחכה לתשובה):\nההזמנה: " + opts.question.order + "\nהשאלה: " + opts.question.question + "\nאם ההודעה עונה עליה, לפתוח את ההזמנה עם התשובה. אם אומרים לוותר עליה, skip_question. השאלה הבאה תישאל אוטומטית, לא לשאול אותה בעצמך." : "");
}

export const TOOLS = [
  { name: "find_clients", description: "מחפש לקוחות עסקיים לפי שם, כינוי, ח.פ. או טלפון. מחזיר עד 8 התאמות.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "find_products", description: "מחפש מוצרים בקטלוג לפי חלק מהשם. מחזיר id, שם ויחידה (kg/unit).", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_client_prices", description: "המחירון השמור של לקוח (₪ לפני מע״מ, לק״ג/ליחידה).", input_schema: { type: "object", properties: { client_id: { type: "string" } }, required: ["client_id"] } },
  { name: "list_orders", description: "רשימת הזמנות פתוחות. סינון לפי תאריך (YYYY-MM-DD), סוג (private/business) וסטטוס (new/packed/fired).", input_schema: { type: "object", properties: { date: { type: "string" }, kind: { type: "string", enum: ["private", "business"] }, status: { type: "string", enum: ["new", "packed", "fired"] } } } },
  { name: "get_order", description: "פרטי הזמנה לפי מספר (למשל B-1043 או 981).", input_schema: { type: "object", properties: { number: { type: "string" } }, required: ["number"] } },
  { name: "create_order", description: "יוצר הזמנה עסקית.", input_schema: { type: "object", properties: {
    client_id: { type: "string" }, delivery_date: { type: "string", description: "YYYY-MM-DD" }, pickup: { type: "boolean" },
    items: { type: "array", items: { type: "object", properties: { product_id: { type: "string" }, amount: { type: "number" }, pieces: { type: "boolean", description: "true כשמוצר במשקל הוזמן ביחידות (\"2 יח׳ פילה סלמון\"): amount הוא מספר היחידות, ושוקלים באריזה" }, note: { type: "string", description: "הערה לפריט, למשל \"לפלט, להביא ראש ואידרה\"" } }, required: ["product_id", "amount"] } },
    note: { type: "string" } }, required: ["client_id", "delivery_date", "items"] } },
  { name: "update_order", description: "משנה הזמנה עסקית: תאריך, איסוף עצמי, או רשימת פריטים חדשה במקום הקיימת (רק לפני שהתחילו לארוז).", input_schema: { type: "object", properties: {
    number: { type: "string" }, delivery_date: { type: "string" }, pickup: { type: "boolean" },
    items: { type: "array", items: { type: "object", properties: { product_id: { type: "string" }, amount: { type: "number" }, pieces: { type: "boolean", description: "true כשמוצר במשקל הוזמן ביחידות (\"2 יח׳ פילה סלמון\"): amount הוא מספר היחידות, ושוקלים באריזה" }, note: { type: "string", description: "הערה לפריט, למשל \"לפלט, להביא ראש ואידרה\"" } }, required: ["product_id", "amount"] } } }, required: ["number"] } },
  { name: "cancel_order", description: "מבקש לבטל הזמנה. דורש אישור \"כן\" מהשולח.", input_schema: { type: "object", properties: { number: { type: "string" } }, required: ["number"] } },
  { name: "set_price", description: "שומר מחיר ללקוח למוצר. מחיר חדש נשמר מיד; שינוי מחיר קיים דורש אישור \"כן\".", input_schema: { type: "object", properties: { client_id: { type: "string" }, product_id: { type: "string" }, price: { type: "number" } }, required: ["client_id", "product_id", "price"] } },
  { name: "past_prices", description: "המחיר האחרון ששילם הלקוח על כל מוצר, מהמסמכים שלו במורנינג בשנה האחרונה (לפני מע״מ), לצד המחיר הרגיל.", input_schema: { type: "object", properties: { client_id: { type: "string" } }, required: ["client_id"] } },
  { name: "set_price_mode", description: "קובע את סוג המחירון של לקוח: regular (תמיד המחיר הרגיל מהקטלוג) או special (מחירים מיוחדים שנשמרים עם set_price).", input_schema: { type: "object", properties: { client_id: { type: "string" }, mode: { type: "string", enum: ["regular", "special"] } }, required: ["client_id", "mode"] } },
  { name: "remember", description: "שומר לתמיד משהו שלימדו אותך (כלל, העדפה, פרט קבוע על לקוח). client_id אם זה על לקוח מסוים.", input_schema: { type: "object", properties: { fact: { type: "string" }, client_id: { type: "string" } }, required: ["fact"] } },
  { name: "forget", description: "מוחק משהו מהזיכרון הקבוע לפי ה-id שלו (מהרשימה \"דברים שלימדו אותך\").", input_schema: { type: "object", properties: { memory_id: { type: "string" } }, required: ["memory_id"] } },
  { name: "skip_question", description: "מוותר על השאלה הפתוחה (ההזמנה שלה לא תיפתח), למשל כשאומרים \"תדלגי\" או \"לא צריך\".", input_schema: { type: "object", properties: {} } },
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

/** The client's past prices from morning, or null when morning cannot be reached (Emily then just asks). */
async function pastPrices(s, clientId) {
  if (!s.pastPrices) return null;
  try { return await s.pastPrices(clientId); } catch { return null; }
}

/** A morning price this far from the regular price is probably for another unit (kg vs. piece): not saved. */
const plausible = (price, regular) => regular == null || (price >= regular * 0.55 && price <= regular * 1.8);

/** Makes sure an order's items have prices, without ever stopping the order (the owner: "בוצע" unless critical).
 *  New client (no price list yet): his last prices from morning are saved as his prices; no documents → regular prices.
 *  An item without his own price: what he paid last time (saved), otherwise the regular price at FIRE.
 *  Returns short notes for Emily to mention. */
async function settlePrices(s, clientId, items) {
  const client = await s.getClient(clientId);
  if (!client) throw new Error("לקוח לא נמצא");
  const own = new Set((await s.clientPrices(clientId)).map((p) => p.product_id));
  const catalog = await s.findProducts("");
  const byId = Object.fromEntries(catalog.map((p) => [p.id, p]));
  const notes = [];
  let mode = client.price_mode || (own.size ? "special" : null);
  let past;
  const loadPast = async () => (past === undefined ? (past = await pastPrices(s, clientId)) : past);
  const save = async (productId, price) => { await s.rpc("wa_set_price", { p_client: clientId, p_product: productId, p_price: price }); own.add(productId); };
  if (!mode && (await loadPast())) {
    if (past.prices.length) {
      let n = 0;
      for (const p of past.prices) if (plausible(p.price, p.regular)) { await save(p.product_id, p.price); n++; }
      notes.push("לקוח חדש: נשמרו לו " + n + " מחירים לפי מה ששילם במורנינג");
      mode = "special";
    } else {
      await s.rpc("wa_set_price_mode", { p_client: clientId, p_mode: "regular" });
      notes.push("לקוח חדש בלי מסמכים במורנינג: מחירים רגילים");
      mode = "regular";
    }
  }
  for (const it of items) {
    if (own.has(it.product_id)) continue;
    const prod = byId[it.product_id];
    if (!prod) continue;
    const regular = prod.list_price != null ? Number(prod.list_price) : null;
    if (mode !== "regular" && (await loadPast())) {
      const last = past.prices.find((p) => p.product_id === it.product_id);
      if (last && plausible(last.price, regular)) { await save(it.product_id, last.price); notes.push(prod.name + ": ₪" + last.price + " לפי מה ששילם בפעם האחרונה"); continue; }
      if (last) notes.push(prod.name + ": במורנינג שילם ₪" + last.price + " מול רגיל ₪" + regular + ", כנראה ליחידה אחרת. נשאר הרגיל, כדאי לבדוק");
      else if (regular != null && mode === "special") notes.push(prod.name + ": אין לו מחיר משלו, לפי הרגיל ₪" + regular);
    }
    if (regular == null) notes.push(prod.name + ": אין מחיר בכלל. צריך להוסיף מחיר לפני ההפקה");
  }
  return notes;
}

async function runTool(deps, phone, name, input, ctx = { created: [] }) {
  const s = deps.store;
  switch (name) {
    case "find_clients": return (await s.findClients(String(input.query || ""))).slice(0, 8);
    case "find_products": return (await s.findProducts(String(input.query || ""))).slice(0, 10);
    case "get_client_prices": return await s.clientPrices(input.client_id);
    case "list_orders": return await s.listOrders({ date: isDate(input.date) ? input.date : null, kind: input.kind || null, status: input.status || null });
    case "get_order": return (await s.getOrder(String(input.number || "").trim())) || { error: "הזמנה לא נמצאה" };
    case "create_order": {
      if (!isDate(input.delivery_date)) return { error: "חסר תאריך תקין" };
      const notes = await settlePrices(s, input.client_id, input.items || []);
      const made = await s.rpc("wa_create_order", { p_client: input.client_id, p_date: input.delivery_date, p_pickup: !!input.pickup, p_items: input.items || [], p_note: input.note || null });
      if (made?.number) ctx.created.push(made.number);
      return notes.length ? { ...made, price_notes: notes } : made;
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
    case "skip_question": if (!ctx.open) return { error: "אין שאלה פתוחה" }; ctx.skipped = true; return { skipped: true };
    case "past_prices": return (await pastPrices(s, input.client_id)) || { error: "לא הצלחתי לקרוא את המסמכים ממורנינג" };
    case "set_price_mode": {
      if (!["regular", "special"].includes(input.mode)) return { error: "סוג מחירון לא תקין" };
      await s.rpc("wa_set_price_mode", { p_client: input.client_id, p_mode: input.mode });
      return { saved: true, mode: input.mode };
    }
    case "remember": {
      const fact = String(input.fact || "").trim();
      if (!fact) return { error: "אין מה לזכור" };
      return { saved: true, id: await s.remember({ fact: fact.slice(0, 500), client_id: input.client_id || null, phone }) };
    }
    case "forget": return (await s.forget(String(input.memory_id || ""))) ? { forgotten: true } : { error: "לא מצאתי את זה בזיכרון" };
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

/** First step for a new message: only allowed numbers, each message once, and "typing…" straight away.
 *  Returns true when the message should be answered. */
export async function receive(deps, { id, phone, text }) {
  const s = deps.store;
  phone = normalizePhone(phone);
  if (!(await s.isAllowed(phone))) return false;
  if (!(await s.saveIncoming({ id, phone, body: text }))) return false; // WhatsApp sent it twice
  if (deps.typing) { try { await deps.typing(id); } catch { /* only cosmetic */ } }
  return true;
}

/** Could this message hold more than one order? (several blocks, or several "header:" lines). Cheap check, no AI. */
export function maybeSeveralOrders(text) {
  const t = String(text || "").trim();
  if (t.length < 40) return false;
  const blocks = t.split(/\n\s*\n/).filter((b) => b.trim()).length;
  const headers = t.split("\n").filter((l) => /^[^:\n]{2,60}:/.test(l.trim())).length;
  return blocks >= 2 || headers >= 2;
}

/** Splits a message into one text per order (AI, no tools). One order, or anything unclear, comes back as [text]. */
export async function splitOrders(deps, text) {
  const res = await deps.claude({
    model: deps.model || "claude-sonnet-5-5", max_tokens: 4000,
    system: `מפצלים הודעת וואטסאפ של חנות דגים להזמנות נפרדות: הזמנה אחת לכל לקוח (מסעדה) ולכל יום.
מחזירים JSON בלבד, בלי שום טקסט אחר: {"orders": ["...", "..."]}
- להעתיק את הטקסט של כל הזמנה כמו שהוא, מילה במילה, כולל הערות.
- אם יום או תאריך כתוב פעם אחת ושייך לכמה הזמנות, להוסיף אותו בתחילת כל אחת מהן.
- אם יש רק הזמנה אחת, או שזו לא הזמנה (שאלה, אישור, מחירים), להחזיר מערך עם ההודעה כולה.`,
    messages: [{ role: "user", content: String(text) }],
  });
  const raw = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  try {
    const parts = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)).orders;
    if (Array.isArray(parts) && parts.length && parts.every((x) => typeof x === "string" && x.trim())) return parts.map((x) => x.trim());
  } catch { /* fall through */ }
  return [String(text)];
}

/** Longest Emily keeps working on one message before she says so (the server allows 150 s per request). */
export const TIME_BUDGET_MS = 100_000;
const TOO_LONG = "זה לוקח לי יותר מדי זמן, אז עצרתי באמצע. כדאי לפצל את ההודעה (למשל הזמנה אחת בכל הודעה) ולשלוח שוב. מה שכבר אישרתי נשמר.";

/** The AI loop: up to 8 rounds of tool use. Returns the final text and what was done (ctx.created, ctx.skipped). */
async function converse(deps, { id, phone }, msgs, systemText, ctx, budgetMs) {
  const started = (deps.now || Date.now)();
  // The fixed part (tools + rules + catalog) is cached by the API, so each turn starts faster and costs less.
  const system = [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }];
  for (let turn = 0; turn < 8; turn++) {
    if ((deps.now || Date.now)() - started > budgetMs) return { text: TOO_LONG, timedOut: true };
    // "typing…" lasts 25 seconds in WhatsApp, so show it again on every round of work
    if (turn > 0 && deps.typing) { try { await deps.typing(id); } catch { /* only cosmetic */ } }
    const res = await deps.claude({ model: deps.model || "claude-sonnet-5-5", max_tokens: 1200, system, tools: TOOLS, messages: msgs });
    msgs.push({ role: "assistant", content: res.content });
    const uses = (res.content || []).filter((b) => b.type === "tool_use");
    if (!uses.length || res.stop_reason !== "tool_use")
      return { text: (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() };
    // independent tools (several clients, several orders) run side by side
    const results = await Promise.all(uses.map(async (u) => {
      let out;
      try { out = await runTool(deps, phone, u.name, u.input || {}, ctx); } catch (e) { out = { error: e.message || "שגיאה" }; }
      return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out ?? null) };
    }));
    msgs.push({ role: "user", content: results });
  }
  return { text: "מצטער, משהו השתבש. נסו לנסח שוב." };
}

async function context(s) {
  let catalog = [], memory = [];
  try { catalog = await s.findProducts(""); } catch { /* the AI can still search */ }
  try { memory = s.memory ? await s.memory() : []; } catch { /* answer without it rather than not at all */ }
  return { catalog, memory };
}

/** How a waiting question is shown: the question, and how many more come after it. */
export const questionText = (q) => "❓ " + q.question + (q.remaining ? "\n(אחרי זו יש עוד " + q.remaining + (q.remaining === 1 ? " שאלה)" : " שאלות)") : "");

/** The one message sent after all the orders of a multi-order message were handled:
 *  "בוצע ✅" with a line per opened order, then the first critical question (the others follow one by one). */
export function batchSummary(parts) {
  const done = parts.filter((p) => p.result === "done"), open = parts.filter((p) => p.result !== "done");
  let t = done.length
    ? "בוצע ✅ " + (open.length ? done.length + " מתוך " + parts.length + " הזמנות" : done.length === 1 ? "הזמנה אחת" : done.length + " הזמנות") + ":\n" + done.map((p) => "• " + p.result_text).join("\n")
    : "עוד לא נפתחה אף הזמנה.";
  if (open.length) t += "\n\n" + questionText({ question: open[0].result_text, remaining: open.length - 1 });
  return t;
}

/** One order out of a message with several: worked on alone (no chat history, so other orders cannot get mixed in),
 *  and nothing is sent. Returns {status: "done", text: one line} when the order was opened, else
 *  {status: "question", text: the one critical question}. */
export async function handleBatchPart(deps, { id, phone, text }) {
  const s = deps.store;
  const { catalog, memory } = await context(s);
  const ctx = { created: [] };
  const out = await converse(deps, { id, phone: normalizePhone(phone) }, [{ role: "user", content: text }],
    systemPrompt(deps.today(), catalog, memory, { batch: true }), ctx, deps.batchBudgetMs ?? 60_000);
  let line = String(out.text || "").replace(/^בוצע\s*✅?\s*/, "").split("\n").filter((l) => l.trim()).join(" · ").slice(0, 300);
  if (ctx.created.length) {
    if (!ctx.created.every((n) => line.includes(n))) line = ctx.created.join(", ") + " · " + line;
    return { status: "done", text: line };
  }
  return { status: "question", text: out.timedOut ? "לא הספקתי לפתוח את ההזמנה: \"" + text.slice(0, 80) + "\". לשלוח אותה שוב?" : line || "לא הצלחתי לפתוח את ההזמנה: \"" + text.slice(0, 80) + "\"" };
}

/** Handles one incoming text message. Returns the reply sent (or null when nothing was sent).
 *  With {received: true} the message was already checked and saved by receive();
 *  {current} is this message's row id, so the history can leave it out and add it last. */
export async function handleMessage(deps, { id, phone, text }, { received = false, current = null } = {}) {
  const s = deps.store;
  phone = normalizePhone(phone);
  if (!received && !(await receive(deps, { id, phone, text }))) return null;
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
  // the conversation so far (the store may leave out this message; it is added last below)
  for (const m of await s.history(phone, 16, current ? { exclude: current } : undefined)) {
    const role = m.direction === "in" ? "user" : "assistant";
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += "\n" + m.body;
    else msgs.push({ role, content: m.body });
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (current) { // history left this message out: add it at the end
    if (msgs.length && msgs[msgs.length - 1].role === "user") msgs[msgs.length - 1].content += "\n" + text;
    else msgs.push({ role: "user", content: text });
  } else if (!msgs.length || msgs[msgs.length - 1].role !== "user") msgs.push({ role: "user", content: text });

  const { catalog, memory } = await context(s);
  // a critical question Emily asked about one order of a multi-order message, still waiting for its answer
  const open = s.openQuestion ? await s.openQuestion(phone).catch(() => null) : null;
  const ctx = { created: [], open };
  const out = await converse(deps, { id, phone }, msgs, systemPrompt(deps.today(), catalog, memory, { question: open }), ctx, deps.budgetMs ?? TIME_BUDGET_MS);
  let t = out.text;
  // the question was answered (its order is now open) or dropped: ask the next one, if any
  if (open && (ctx.created.length || ctx.skipped)) {
    await s.resolveQuestion(open.id);
    const next = await s.nextQuestion(phone);
    if (next) t = (t ? t + "\n\n" : "") + questionText(next);
  }
  return t ? reply(t) : null;
}
