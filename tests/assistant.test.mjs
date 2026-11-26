import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMessage, normalizePhone, receive, systemPrompt } from "../supabase/functions/_shared/assistant.js";

const OWNER = "+972500000001", STAFF = "+972500000002", STRANGER = "+972500000009";

function fakeWorld(script) {
  const w = {
    sent: [], rpcCalls: [], pending: {}, seen: new Set(), log: [], allowed: { [OWNER]: true, [STAFF]: false }, issues: [],
    prices: [{ client_id: "c1", product_id: "p-salmon", product: "סלמון", price: 120 }],
    claudeCalls: [],
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
    clientPrices: async (c) => w.prices.filter((p) => p.client_id === c),
    listOrders: async () => [],
    getOrder: async (n) => (n === "B-1043" ? { number: "B-1043", client: "ברוס בורגר", date: "2026-11-24" } : null),
    rpc: async (name, args) => { w.rpcCalls.push([name, args]); return name === "wa_create_order" ? { number: "B-1043" } : null; },
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

test("an order is blocked until the client has a price for every product", async () => {
  let seen;
  const w = fakeWorld([
    use("create_order", { client_id: "c1", delivery_date: "2026-11-24", items: [{ product_id: "p-tuna", amount: 2 }] }),
    (body) => { seen = lastToolResult(body); return say("מה המחיר לטונה לברוס?")(); },
  ]);
  await handleMessage(w.deps, { id: "m1", phone: OWNER, text: "2 קילו טונה לברוס למחר" });
  assert.equal(seen.error, "missing_prices");
  assert.deepEqual(seen.missing_products, ["טונה"]);
  assert.equal(w.rpcCalls.length, 0);
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

test("the prompt tells the AI today's date and the coming days", () => {
  const p = systemPrompt("2026-11-23");
  assert.match(p, /שני 2026-11-23/);
  assert.match(p, /שלישי 2026-11-24/);
  assert.match(p, /אמילי/);
});
