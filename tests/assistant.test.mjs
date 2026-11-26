import { test } from "node:test";
import assert from "node:assert/strict";
import { batchSummary, handleBatchPart, handleMessage, maybeSeveralOrders, normalizePhone, receive, splitOrders, systemPrompt } from "../supabase/functions/_shared/assistant.js";

const OWNER = "+972500000001", STAFF = "+972500000002", STRANGER = "+972500000009";

function fakeWorld(script) {
  const w = {
    sent: [], rpcCalls: [], pending: {}, seen: new Set(), log: [], allowed: { [OWNER]: true, [STAFF]: false }, issues: [],
    prices: [{ client_id: "c1", product_id: "p-salmon", product: "סלמון", price: 120 }],
    claudeCalls: [], clients: { c1: { id: "c1", name: "ברוס בורגר בע״מ", price_mode: "special" }, c2: { id: "c2", name: "מסעדה חדשה", price_mode: null } },
    memory: [], past: { c2: [{ product_id: "p-tuna", name: "טונה", unit: "kg", price: 330, regular: 340, date: "2026-11-20" }] },
  };
  w.store = {
    isAllowed: async (p) => p in w.allowed,
    isOwner: async (p) => w.allowed[p] === true,
    saveIncoming: async (m) => { if (w.seen.has(m.id)) return false; w.seen.add(m.id); w.log.push({ direction: "in", body: m.body, phone: m.phone }); return true; },
    saveOutgoing: async (phone, body) => { w.log.push({ direction: "out", body, phone }); },
    history: async (phone) => w.log.filter((m) => m.phone === phone),
    getPending: async (p) => w.pending[p] || null,
    setPending: async (p, v) => { w.pending[p] = { ...v, created_at: new Date().toISOString() }; },
    clearPending: async (p) => { delete w.pending[p]; },
    findClients: async (q) => (q.includes("ברוס") ? [{ id: "c1", name: "ברוס בורגר בע״מ", aliases: ["ברוס"] }] : []),
    findProducts: async () => [{ id: "p-salmon", name: "סלמון", unit: "kg" }, { id: "p-tuna", name: "טונה", unit: "kg" }],
    getClient: async (id) => w.clients[id] || null,
    memory: async () => w.memory.filter((m) => !m.gone),
    remember: async (m) => { const id = "mem-" + (w.memory.length + 1); w.memory.push({ id, fact: m.fact, client: m.client_id ? w.clients[m.client_id]?.name : null }); return id; },
    forget: async (id) => { const m = w.memory.find((x) => x.id === id && !x.gone); if (m) m.gone = true; return !!m; },
    pastPrices: async (c) => ({ documents: 3, prices: w.past[c] || [] }),
    clientPrices: async (c) => w.prices.filter((p) => p.client_id === c),
    listOrders: async () => [],
    getOrder: async (n) => (n === "B-1043" ? { number: "B-1043", client: "ברוס בורגר", date: "2026-11-24" } : null),
    rpc: async (name, args) => { w.rpcCalls.push([name, args]); if (name === "wa_set_price_mode") w.clients[args.p_client].price_mode = args.p_mode; return name === "wa_create_order" ? { number: "B-1043" } : null; },
    addAllowed: async (p) => { w.allowed[p] = false; },
    removeAllowed: async (p) => { delete w.allowed[p]; },
    createIssue: async (t) => { w.issues.push(t); return "https://github.com/x/issues/1"; },
  };
  let step = 0;
  w.deps = {
    store: w.store, today: () => "2026-11-23",
    send: async (phone, text) => { w.sent.push([phone, text]); },
    claude: async (body) => { w.claudeCalls.push(body); return script[step++](body); },
  };
  return w;
}
const say = (text) => () => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });
const use = (name, input) => () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t" + Math.random(), name, input }] });
const lastToolResult = (body) => JSON.parse(body.messages.at(-1).content[0].content);

test("phone numbers are normalised to +972", () => {
  assert.equal(normalizePhone("972526684400"), "+972526684400");
  assert.equal(normalizePhone("052-668-4400"), "+972526684400");
  assert.equal(normalizePhone("+972 52 668 4400"), "+972526684400");
});

test("messages from numbers not on the list are ignored", async () => {
  const w = fakeWorld([]);
  assert.equal(await handleMessage(w.deps, { id: "m1", phone: STRANGER.slice(1), text: "שלום" }), null);
  assert.equal(w.sent.length, 0);
  assert.equal(w.claudeCalls.length, 0);
});

test("the same message delivered twice is answered once", async () => {
  const w = fakeWorld([say("היי")]);
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "היי" });
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "היי" });
  assert.equal(w.sent.length, 1);
});

test("an order with known prices is created", async () => {
  const w = fakeWorld([
    use("create_order", { client_id: "c1", delivery_date: "2026-11-24", items: [{ product_id: "p-salmon", amount: 2 }] }),
    say("בוצע: הזמנה B-1043"),
  ]);
  const r = await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "2 קילו סלמון לברוס למחר" });
  assert.equal(w.rpcCalls[0][0], "wa_create_order");
  assert.equal(w.rpcCalls[0][1].p_date, "2026-11-24");
  assert.match(r, /B-1043/);
});

test("cancelling waits for YES, and the YES is handled without the AI", async () => {
  const w = fakeWorld([use("cancel_order", { number: "B-1043" }), say("לבטל את B-1043? השב כן")]);
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "תבטל את B-1043" });
  assert.equal(w.rpcCalls.length, 0, "nothing cancelled yet");
  assert.ok(w.pending[OWNER]);
  const r = await handleMessage(w.deps, { id: "m2", phone: OWNER, text: "כן!" });
  assert.deepEqual(w.rpcCalls[0], ["wa_cancel_order", { p_number: "B-1043" }]);
  assert.match(r, /בוטלה/);
  assert.equal(w.claudeCalls.length, 2, "the YES did not go to the AI");
});

test("NO or any other reply drops the pending action", async () => {
  const w = fakeWorld([use("cancel_order", { number: "B-1043" }), say("לאשר?")]);
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "בטל B-1043" });
  const r = await handleMessage(w.deps, { id: "m2", phone: OWNER, text: "לא" });
  assert.match(r, /לא בוצע/);
  assert.equal(w.rpcCalls.length, 0);
  assert.equal(w.pending[OWNER], undefined);
});

test("a new price saves at once; changing a saved price needs YES", async () => {
  const w = fakeWorld([
    use("set_price", { client_id: "c1", product_id: "p-tuna", price: 350 }), say("נשמר"),
    use("set_price", { client_id: "c1", product_id: "p-salmon", price: 130 }), say("לשנות 120 ל-130? השב כן"),
  ]);
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "טונה לברוס 350" });
  assert.deepEqual(w.rpcCalls[0], ["wa_set_price", { p_client: "c1", p_product: "p-tuna", p_price: 350 }]);
  await handleMessage(w.deps, { id: "m2", phone: OWNER, text: "סלמון לברוס עכשיו 130" });
  assert.equal(w.rpcCalls.length, 1, "the change is waiting");
  assert.match(w.pending[OWNER].summary, /120 ← ₪130/);
  await handleMessage(w.deps, { id: "m3", phone: OWNER, text: "כן" });
  assert.deepEqual(w.rpcCalls[1], ["wa_set_price", { p_client: "c1", p_product: "p-salmon", p_price: 130 }]);
});

test("only the owner can add numbers, and only after YES", async () => {
  let staffResult;
  const w = fakeWorld([
    use("manage_allowed_number", { action: "add", phone: "0501112233", name: "דני" }),
    (b) => { staffResult = lastToolResult(b); return say("רק הבעלים")(); },
    use("manage_allowed_number", { action: "add", phone: "0501112233", name: "דני" }), say("להוסיף? השב כן"),
  ]);
  await handleMessage(w.deps, { id: "m1", phone: STAFF, text: "תוסיף את דני" });
  assert.match(staffResult.error, /רק הבעלים/);
  await handleMessage(w.deps, { id: "m2", phone: OWNER, text: "תוסיף את דני 0501112233" });
  assert.equal("+972501112233" in w.allowed, false);
  await handleMessage(w.deps, { id: "m3", phone: OWNER, text: "כן" });
  assert.equal("+972501112233" in w.allowed, true);
});

test("app change requests become an issue after YES", async () => {
  const w = fakeWorld([use("request_app_change", { title: "כפתור הדפסה בדף משלוחים", details: "..." }), say("לרשום? השב כן")]);
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "תוסיף כפתור הדפסה" });
  const r = await handleMessage(w.deps, { id: "m2", phone: OWNER, text: "yes" });
  assert.deepEqual(w.issues, ["כפתור הדפסה בדף משלוחים"]);
  assert.match(r, /נרשמה/);
});

test("Emily shows typing and gets the catalog in her instructions", async () => {
  const w = fakeWorld([say("היי")]);
  const typed = [];
  w.deps.typing = async (id) => { typed.push(id); };
  await handleMessage(w.deps, { id: "m7", phone: OWNER, text: "היי" });
  assert.deepEqual(typed, ["m7"]);
  const sys = w.claudeCalls[0].system[0];
  assert.match(sys.text, /p-salmon · סלמון · ק״ג/);
  assert.deepEqual(sys.cache_control, { type: "ephemeral" });
});

test("a message that takes too long gets a clear answer instead of silence", async () => {
  let clock = 0;
  const w = fakeWorld([
    () => { clock += 60_000; return use("find_clients", { query: "ברוס" })(); },
    () => { clock += 60_000; return use("find_products", { query: "סלמון" })(); },
    say("never reached"),
  ]);
  w.deps.now = () => clock;
  const r = await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "הרבה הזמנות" });
  assert.match(r, /יותר מדי זמן/);
  assert.equal(w.claudeCalls.length, 2);
});

test("receive() saves and filters; handleMessage then answers without saving again", async () => {
  const w = fakeWorld([say("היי")]);
  assert.equal(await receive(w.deps, { id: "m1", phone: STRANGER, text: "x" }), false);
  assert.equal(await receive(w.deps, { id: "m2", phone: OWNER, text: "היי" }), true);
  assert.equal(await receive(w.deps, { id: "m2", phone: OWNER, text: "היי" }), false, "duplicate");
  const r = await handleMessage(w.deps, { id: "m2", phone: OWNER, text: "היי" }, { received: true });
  assert.equal(r, "היי");
});

test("several orders in one message are spotted and split; a single order is left alone", async () => {
  const two = "למחר(שלישי): קנטינה\n10 קילו פילה דניס\n\nלמחר(שלישי): הרצל 16\n1 ארגז אמצי יפני";
  assert.equal(maybeSeveralOrders(two), true);
  assert.equal(maybeSeveralOrders("2 קילו סלמון לברוס למחר"), false);
  assert.equal(maybeSeveralOrders("כן"), false);
  const w = fakeWorld([() => ({ stop_reason: "end_turn", content: [{ type: "text", text: "הנה:\n" + JSON.stringify({ orders: ["למחר: קנטינה\n10 קילו דניס", "למחר: הרצל 16\n1 ארגז אמצי"] }) }] })]);
  assert.deepEqual(await splitOrders(w.deps, two), ["למחר: קנטינה\n10 קילו דניס", "למחר: הרצל 16\n1 ארגז אמצי"]);
  const bad = fakeWorld([say("לא JSON")]);
  assert.deepEqual(await splitOrders(bad.deps, two), [two], "unclear answer keeps the message whole");
});

test("a client on regular prices needs no saved price for an item with a regular price", async () => {
  const w = fakeWorld([
    use("create_order", { client_id: "c1", delivery_date: "2026-11-24", items: [{ product_id: "p-tuna", amount: 2 }] }),
    say("בוצע"),
  ]);
  const base = w.store.findProducts;
  w.store.findProducts = async (q) => (await base(q)).map((p) => (p.id === "p-tuna" ? { ...p, list_price: 340 } : p));
  w.clients.c1.price_mode = "regular";
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "2 קילו טונה לברוס למחר" });
  assert.equal(w.rpcCalls[0][0], "wa_create_order");
  assert.match(w.claudeCalls[0].system[0].text, /p-tuna · טונה · ק״ג · ₪340/);
});

test("the prompt tells the AI today's date and the coming days", () => {
  const p = systemPrompt("2026-11-23");
  assert.match(p, /שני 2026-11-23/);
  assert.match(p, /שלישי 2026-11-24/);
  assert.match(p, /אמילי/);
});

test("things taught on WhatsApp stay in Emily's instructions until she is told to forget them", async () => {
  const w = fakeWorld([
    use("remember", { fact: "לברוס תמיד לנקות את הדג", client_id: "c1" }), say("אזכור: לברוס תמיד לנקות את הדג"),
    say("בטח"),
    use("forget", { memory_id: "mem-1" }), say("שכחתי"),
    say("אוקיי"),
  ]);
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "תזכרי שלברוס תמיד מנקים את הדג" });
  await handleMessage(w.deps, { id: "m2", phone: OWNER, text: "היי" });
  assert.match(w.claudeCalls[2].system[0].text, /\[mem-1\] \(ברוס בורגר בע״מ\) לברוס תמיד לנקות את הדג/);
  await handleMessage(w.deps, { id: "m3", phone: OWNER, text: "תשכחי את זה" });
  await handleMessage(w.deps, { id: "m4", phone: OWNER, text: "היי" });
  assert.doesNotMatch(w.claudeCalls[5].system[0].text, /לנקות את הדג/);
});


const priceCalls = (w) => w.rpcCalls.filter(([n]) => n === "wa_set_price").map(([, a]) => [a.p_client, a.p_product, a.p_price]);
const withRegular = (w, prices) => { const base = w.store.findProducts; w.store.findProducts = async (q) => (await base(q)).map((p) => (p.id in prices ? { ...p, list_price: prices[p.id] } : p)); };
const createOrder = (client, product = "p-tuna") => use("create_order", { client_id: client, delivery_date: "2026-11-24", items: [{ product_id: product, amount: 2 }] });

test("an order is never stopped for a missing price; Emily is told what is missing", async () => {
  let seen;
  const w = fakeWorld([createOrder("c1"), (body) => { seen = lastToolResult(body); return say("בוצע ✅ B-1043")(); }]);
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "2 קילו טונה לברוס למחר" });
  assert.equal(w.rpcCalls.at(-1)[0], "wa_create_order");
  assert.equal(seen.number, "B-1043");
  assert.match(seen.price_notes.join(" "), /טונה: אין מחיר בכלל/);
});

test("a new client gets the prices he paid in morning saved as his own, without being asked", async () => {
  let seen;
  const w = fakeWorld([createOrder("c2"), (body) => { seen = lastToolResult(body); return say("בוצע ✅ B-1043")(); }]);
  withRegular(w, { "p-tuna": 340 });
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "2 קילו טונה למסעדה חדשה למחר" });
  assert.deepEqual(priceCalls(w), [["c2", "p-tuna", 330]]);
  assert.equal(w.rpcCalls.at(-1)[0], "wa_create_order");
  assert.match(seen.price_notes[0], /נשמרו לו 1 מחירים/);
});

test("a new client with no morning documents goes on regular prices for good", async () => {
  const w = fakeWorld([createOrder("c2"), say("בוצע")]);
  w.past.c2 = [];
  withRegular(w, { "p-tuna": 340 });
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "2 קילו טונה למסעדה חדשה למחר" });
  assert.equal(w.clients.c2.price_mode, "regular");
  assert.deepEqual(priceCalls(w), []);
  assert.equal(w.rpcCalls.at(-1)[0], "wa_create_order");
});

test("a special client's item without his own price takes what he paid last time", async () => {
  const w = fakeWorld([createOrder("c1"), say("בוצע")]);
  w.past.c1 = [{ product_id: "p-tuna", name: "טונה", unit: "kg", price: 350, regular: 340, date: "2026-10-01" }];
  withRegular(w, { "p-tuna": 340 });
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "2 קילו טונה לברוס למחר" });
  assert.deepEqual(priceCalls(w), [["c1", "p-tuna", 350]]);
});

test("a morning price far from the regular one (probably another unit) is not saved", async () => {
  let seen;
  const w = fakeWorld([createOrder("c1"), (body) => { seen = lastToolResult(body); return say("בוצע")(); }]);
  w.past.c1 = [{ product_id: "p-tuna", name: "טונה", unit: "kg", price: 150, regular: 340, date: "2026-10-01" }];
  withRegular(w, { "p-tuna": 340 });
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "2 קילו טונה לברוס למחר" });
  assert.deepEqual(priceCalls(w), []);
  assert.match(seen.price_notes.join(" "), /כנראה ליחידה אחרת/);
});

test("if morning cannot be reached the order is still opened, and the client is decided next time", async () => {
  const w = fakeWorld([createOrder("c2"), say("בוצע")]);
  w.store.pastPrices = async () => { throw new Error("down"); };
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "2 קילו טונה למסעדה חדשה למחר" });
  assert.equal(w.rpcCalls.at(-1)[0], "wa_create_order");
  assert.equal(w.clients.c2.price_mode, null);
});

test("one order of a multi-order message: nothing is sent, no chat history is used, and the result is one line", async () => {
  const w = fakeWorld([createOrder("c1", "p-salmon"), say("בוצע ✅ ברוס בורגר · 2 ק״ג סלמון")]);
  w.log.push({ direction: "in", body: "הזמנה ישנה למישהו אחר", phone: OWNER });
  const r = await handleBatchPart(w.deps, { id: "m1", phone: OWNER, text: "למחר: ברוס\n2 קילו סלמון" });
  assert.deepEqual(r, { status: "done", text: "B-1043 · ברוס בורגר · 2 ק״ג סלמון" });
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.claudeCalls[0].messages[0], { role: "user", content: "למחר: ברוס\n2 קילו סלמון" }, "only this order, not the old chat");
  assert.match(w.claudeCalls[0].system[0].text, /מצב כמה הזמנות/);
});

test("an order that needs a critical answer comes back as a question", async () => {
  const w = fakeWorld([say("רוית: יש שני לקוחות, הנדמייד ביי רווית או רוית מבורך?")]);
  const r = await handleBatchPart(w.deps, { id: "m1", phone: OWNER, text: "למחר: רוית\n1 קילו סלמון" });
  assert.equal(r.status, "question");
  assert.match(r.text, /שני לקוחות/);
  assert.equal(w.rpcCalls.length, 0);
});

test("the summary says בוצע with a line per order, then only the first question", () => {
  const t = batchSummary([
    { result: "done", result_text: "B-1 · קנטינה · 20 ק״ג פילה דניס" },
    { result: "question", result_text: "רוית: איזה לקוח?" },
    { result: "done", result_text: "B-2 · בון בון · 12 ק״ג מולים" },
    { result: "question", result_text: "הגפן: איזה מוצר?" },
  ]);
  assert.equal(t, "בוצע ✅ 2 מתוך 4 הזמנות:\n• B-1 · קנטינה · 20 ק״ג פילה דניס\n• B-2 · בון בון · 12 ק״ג מולים\n\n❓ רוית: איזה לקוח?\n(אחרי זו יש עוד 1 שאלה)");
  assert.equal(batchSummary([{ result: "done", result_text: "B-1 · x" }]), "בוצע ✅ הזמנה אחת:\n• B-1 · x");
});

test("answering a question opens its order and asks the next question", async () => {
  const w = fakeWorld([createOrder("c1", "p-salmon"), say("בוצע ✅ B-1043 · ברוס")]);
  const qs = [{ id: "q1", order: "למחר: רוית\n1 קילו סלמון", question: "רוית: איזה לקוח?" }, { id: "q2", question: "הגפן: איזה מוצר?", remaining: 0 }];
  w.store.openQuestion = async () => qs[0];
  const resolved = [];
  w.store.resolveQuestion = async (id) => { resolved.push(id); };
  w.store.nextQuestion = async () => qs[1];
  const r = await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "הראשון" });
  assert.deepEqual(resolved, ["q1"]);
  assert.equal(r, "בוצע ✅ B-1043 · ברוס\n\n❓ הגפן: איזה מוצר?");
  assert.match(w.claudeCalls[0].system[0].text, /שאלה פתוחה[\s\S]*רוית: איזה לקוח/);
});

test("a question that is not answered yet stays open", async () => {
  const w = fakeWorld([say("איזה מהשניים?")]);
  w.store.openQuestion = async () => ({ id: "q1", order: "x", question: "רוית: איזה לקוח?" });
  let resolved = false;
  w.store.resolveQuestion = async () => { resolved = true; };
  w.store.nextQuestion = async () => null;
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "מה?" });
  assert.equal(resolved, false);
});
