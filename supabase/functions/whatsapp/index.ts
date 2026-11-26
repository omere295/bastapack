// WhatsApp webhook for the BastaPack assistant (logic in ../_shared/assistant.js).
// Meta calls this address for every message to the assistant's number.
//   GET  → Meta's one-time webhook check (hub.verify_token must equal WHATSAPP_VERIFY_TOKEN)
//   POST from Meta → the signature is checked with WHATSAPP_APP_SECRET; each text message is saved, "typing…" is shown,
//          and the database is asked (wa_enqueue, migration 0015) to call this function again for that message.
//          Meta gets its 200 at once.
//   POST with x-internal-key (from the database) → answers the oldest waiting message of that person, in the request
//          itself, then queues the next one (migration 0016). One person's messages are answered one at a time, in
//          order; a message with several orders is split into one row per order, the orders are worked on side by side,
//          and one summary is sent ("בוצע ✅" + the critical questions, one at a time; migration 0020). Background work after the
//          reply to Meta was cut off after about a minute (23/11/2026); a request of its own may run up to 150 s.
// Secrets: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, ANTHROPIC_API_KEY,
// optional GITHUB_TOKEN (app change requests become issues in omere295/bastapack), ASSISTANT_MODEL, WHATSAPP_API_VERSION.

import { batchSummary, handleBatchPart, handleMessage, maybeSeveralOrders, normalizePhone, receive, splitOrders } from "../_shared/assistant.js";

const env = (k: string) => Deno.env.get(k) || "";
const SB_URL = env("SUPABASE_URL"), SB_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const GRAPH = "https://graph.facebook.com/" + (env("WHATSAPP_API_VERSION") || "v23.0");
const REPO = "omere295/bastapack";

async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(SB_URL + path, { ...init, headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", ...(init.headers || {}) } });
  const t = await res.text(); const d = t ? JSON.parse(t) : null;
  if (!res.ok) throw new Error((d && d.message) || "שגיאת מסד נתונים");
  return d;
}
const eq = (v: string) => "eq." + encodeURIComponent(v);
const like = (q: string) => encodeURIComponent("*" + q.replace(/[,()*"\\]/g, " ").trim() + "*");
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());

const store = {
  isAllowed: async (p: string) => (await db("/rest/v1/whatsapp_allowed?select=phone&phone=" + eq(p))).length > 0,
  isOwner: async (p: string) => (await db("/rest/v1/whatsapp_allowed?select=phone&is_owner=is.true&phone=" + eq(p))).length > 0,
  saveIncoming: async (m: { id: string; phone: string; body: string }) =>
    (await db("/rest/v1/wa_messages?on_conflict=id", { method: "POST", body: JSON.stringify({ id: m.id, phone: m.phone, direction: "in", body: m.body }), headers: { Prefer: "resolution=ignore-duplicates,return=representation" } })).length > 0,
  saveOutgoing: (phone: string, body: string) => db("/rest/v1/wa_messages", { method: "POST", body: JSON.stringify({ id: "out-" + crypto.randomUUID(), phone, direction: "out", body }) }),
  // The conversation so far: Emily's replies and the messages she already answered. Messages still waiting in the
  // queue (and the one being answered, which handleMessage adds last) are left out, so nothing is answered twice.
  // Messages are placed at the time Emily started answering them, so each reply follows its own message.
  history: async (phone: string, n: number, opts?: { exclude?: string }) => {
    const rows = await db("/rest/v1/wa_messages?select=direction,body,created_at,started_at&hidden=is.false&phone=" + eq(phone) +
      "&or=(direction.eq.out,handled_at.not.is.null)" + (opts?.exclude ? "&id=neq." + encodeURIComponent(opts.exclude) : "") +
      "&created_at=gte." + new Date(Date.now() - 12 * 3600_000).toISOString() + "&order=created_at.desc&limit=" + n);
    const at = (r: any) => Date.parse(r.direction === "in" && r.started_at ? r.started_at : r.created_at);
    return rows.sort((a: any, b: any) => at(a) - at(b));
  },
  getPending: async (phone: string) => (await db("/rest/v1/wa_pending?select=*&phone=" + eq(phone)))[0] || null,
  setPending: (phone: string, p: any) => db("/rest/v1/wa_pending?on_conflict=phone", { method: "POST", body: JSON.stringify({ phone, ...p, created_at: new Date().toISOString() }), headers: { Prefer: "resolution=merge-duplicates" } }),
  clearPending: (phone: string) => db("/rest/v1/wa_pending?phone=" + eq(phone), { method: "DELETE" }),
  findClients: async (q: string) => {
    if (!q.trim()) return [];
    const L = like(q), alias = encodeURIComponent('{"' + q.replace(/["\\{}]/g, "").trim() + '"}');
    const rows = await db("/rest/v1/clients?select=id,business_name,legal_name,company_number,phone,aliases,address,price_mode&active=is.true&limit=8&or=(business_name.ilike." + L + ",legal_name.ilike." + L + ",company_number.ilike." + L + ",phone.ilike." + L + ",aliases.cs." + alias + ")");
    return rows.map((c: any) => ({ id: c.id, name: c.business_name, legal_name: c.legal_name, company_number: c.company_number, aliases: c.aliases, city: c.address?.city || null, price_mode: c.price_mode || null }));
  },
  getClient: async (id: string) => {
    const [c] = await db("/rest/v1/clients?select=id,business_name,price_mode&id=" + eq(id));
    return c ? { id: c.id, name: c.business_name, price_mode: c.price_mode || null } : null;
  },
  // Emily's permanent memory (migration 0018): kept until someone tells her to forget it or an admin removes it.
  memory: async () => (await db("/rest/v1/assistant_memory?select=id,fact,clients(business_name)&deleted_at=is.null&order=created_at&limit=200"))
    .map((m: any) => ({ id: m.id, fact: m.fact, client: m.clients?.business_name || null })),
  remember: async (m: { fact: string; client_id: string | null; phone: string }) =>
    (await db("/rest/v1/assistant_memory", { method: "POST", body: JSON.stringify({ fact: m.fact, client_id: m.client_id, taught_by: m.phone }), headers: { Prefer: "return=representation" } }))[0].id,
  forget: async (id: string) => /^[0-9a-f-]{36}$/i.test(id) &&
    (await db("/rest/v1/assistant_memory?deleted_at=is.null&id=" + eq(id), { method: "PATCH", body: JSON.stringify({ deleted_at: new Date().toISOString() }), headers: { Prefer: "return=representation" } })).length > 0,
  // The last price the client paid for each product, read from his morning documents by the morning function
  // (price_history, allowed with the internal key from the database).
  pastPrices: async (clientId: string) => {
    const key = await db("/rest/v1/rpc/internal_key", { method: "POST", body: "{}" });
    const r = await fetch(SB_URL + "/functions/v1/morning", { method: "POST", signal: AbortSignal.timeout(40_000),
      headers: { Authorization: "Bearer " + env("SUPABASE_ANON_KEY"), "Content-Type": "application/json", "x-cron-key": key },
      body: JSON.stringify({ action: "price_history", client_id: clientId }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "morning " + r.status);
    return { documents: d.documents, prices: d.prices.map((p: any) => ({ product_id: p.product_id, name: p.name, unit: p.unit, price: p.price, regular: p.regular, date: p.date })) };
  },
  // Critical questions from multi-order messages (migration 0020), asked one at a time.
  openQuestion: async (phone: string) => {
    const [q] = await db("/rest/v1/wa_messages?select=id,body,result_text&result=eq.question&asked_at=not.is.null&resolved_at=is.null&phone=" + eq(phone) +
      "&created_at=gte." + new Date(Date.now() - 24 * 3600_000).toISOString() + "&order=created_at&limit=1");
    return q ? { id: q.id, order: q.body, question: q.result_text } : null;
  },
  resolveQuestion: (id: string) => db("/rest/v1/wa_messages?id=" + eq(id), { method: "PATCH", body: JSON.stringify({ resolved_at: new Date().toISOString() }) }),
  nextQuestion: async (phone: string) => {
    const qs = await db("/rest/v1/wa_messages?select=id,result_text&result=eq.question&asked_at=is.null&resolved_at=is.null&phone=" + eq(phone) +
      "&created_at=gte." + new Date(Date.now() - 24 * 3600_000).toISOString() + "&order=created_at&limit=50");
    if (!qs.length) return null;
    await db("/rest/v1/wa_messages?id=" + eq(qs[0].id), { method: "PATCH", body: JSON.stringify({ asked_at: new Date().toISOString() }) });
    return { id: qs[0].id, question: qs[0].result_text, remaining: qs.length - 1 };
  },
  // Emily only takes business orders, so she only sees the business catalog (morning items).
  findProducts: (q: string) => db("/rest/v1/products?select=id,name,unit,sku,list_price&active=is.true&catalog=eq.business&order=name" + (q.trim() ? "&or=(name.ilike." + like(q) + ",sku.ilike." + like(q) + ")" : "")),
  clientPrices: async (c: string) => (await db("/rest/v1/client_prices?select=product_id,price,products(name,unit)&client_id=" + eq(c)))
    .map((r: any) => ({ product_id: r.product_id, product: r.products?.name, unit: r.products?.unit, price: Number(r.price) })),
  listOrders: async (f: { date: string | null; kind: string | null; status: string | null }) => {
    let q = "/rest/v1/orders?select=number,kind,delivery_date,status,pickup,customer_name,clients(business_name),order_items(removed_at)&deleted_at=is.null&order=delivery_date,number&limit=80";
    q += f.date ? "&delivery_date=eq." + f.date : "&delivery_date=gte." + today();
    if (f.kind) q += "&kind=eq." + f.kind;
    if (f.status) q += "&status=eq." + f.status;
    return (await db(q)).map((o: any) => ({ number: o.number, kind: o.kind, date: o.delivery_date, status: o.status, pickup: o.pickup,
      name: o.kind === "business" ? o.clients?.business_name : o.customer_name, items: o.order_items.filter((i: any) => !i.removed_at).length }));
  },
  getOrder: async (n: string) => {
    const [o] = await db("/rest/v1/orders?select=*,order_items(*),clients(business_name)&deleted_at=is.null&number=" + eq(n));
    if (!o) return null;
    return { number: o.number, kind: o.kind, date: o.delivery_date, status: o.status, pickup: o.pickup, client: o.clients?.business_name || null,
      customer: o.customer_name, morning_doc: o.morning_doc_number,
      items: o.order_items.filter((i: any) => !i.removed_at).sort((a: any, b: any) => a.position - b.position)
        .map((i: any) => ({ name: i.name, unit: i.unit, ordered: Number(i.unit === "kg" && i.ordered_kg != null ? i.ordered_kg : i.ordered_count),
          pieces: i.unit === "kg" && i.ordered_kg == null, note: i.note || undefined, final: i.confirmed ? Number(i.final_amount) : null })) };
  },
  rpc: (name: string, args: unknown) => db("/rest/v1/rpc/" + name, { method: "POST", body: JSON.stringify(args) }),
  addAllowed: (phone: string, name: string) => db("/rest/v1/whatsapp_allowed?on_conflict=phone", { method: "POST", body: JSON.stringify({ phone, name, is_owner: false }), headers: { Prefer: "resolution=merge-duplicates" } }),
  removeAllowed: (phone: string) => db("/rest/v1/whatsapp_allowed?is_owner=is.false&phone=" + eq(phone), { method: "DELETE" }),
  createIssue: async (title: string, body: string) => {
    if (!env("GITHUB_TOKEN")) throw new Error("החיבור ל-GitHub עוד לא הוגדר, אז הבקשה לא נשלחה");
    const r = await fetch("https://api.github.com/repos/" + REPO + "/issues", { method: "POST", headers: { Authorization: "Bearer " + env("GITHUB_TOKEN"), Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "bastapack" }, body: JSON.stringify({ title, body, labels: ["whatsapp-change"] }) });
    const d = await r.json();
    if (!r.ok) throw new Error("GitHub סירב: " + (d.message || r.status));
    return d.html_url;
  },
};

async function send(phone: string, text: string) {
  const r = await fetch(GRAPH + "/" + env("WHATSAPP_PHONE_NUMBER_ID") + "/messages", {
    method: "POST", headers: { Authorization: "Bearer " + env("WHATSAPP_TOKEN"), "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: phone.replace(/^\+/, ""), type: "text", text: { body: text.slice(0, 4000), preview_url: true } }),
  });
  if (!r.ok) console.error("whatsapp send failed", r.status, await r.text());
}

// Blue ticks + "typing…" for up to 25 seconds, or until Emily's reply arrives.
async function typing(messageId: string) {
  await fetch(GRAPH + "/" + env("WHATSAPP_PHONE_NUMBER_ID") + "/messages", {
    method: "POST", headers: { Authorization: "Bearer " + env("WHATSAPP_TOKEN"), "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } }),
  });
}

async function claude(body: unknown) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    signal: AbortSignal.timeout(60_000),
    method: "POST", headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("AI: " + (d.error?.message || r.status));
  return d;
}

async function validSignature(raw: string, header: string | null) {
  const secret = env("WHATSAPP_APP_SECRET");
  if (!secret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7);
  if (given.length !== hex.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

const deps = { store, send, claude, typing, today, model: env("ASSISTANT_MODEL") || undefined };

/** Meta's webhook: save, show typing, and queue each text message (answered by answer() below). */
async function intake(payload: any) {
  for (const entry of payload.entry || []) for (const ch of entry.changes || []) for (const m of ch.value?.messages || []) {
    const phone = normalizePhone("+" + String(m.from || ""));
    try {
      if (m.type === "text") {
        if (await receive(deps, { id: m.id, phone, text: m.text?.body || "" })) await db("/rest/v1/rpc/wa_enqueue", { method: "POST", body: JSON.stringify({ p_id: m.id }) });
      } else if (await store.isAllowed(phone) && await store.saveIncoming({ id: m.id, phone, body: "[" + m.type + "]" }))
        await send(phone, "כרגע אני מבינה רק הודעות טקסט. אפשר להעביר אליי הודעה מהמסעדה או לכתוב את ההזמנה.");
    } catch (e) {
      console.error("intake error", e);
      await send(phone, "משהו השתבש אצלי (" + ((e as Error).message || "שגיאה") + "). נסו שוב בעוד רגע.");
    }
  }
}

const rpc = (name: string, args: unknown) => db("/rest/v1/rpc/" + name, { method: "POST", body: JSON.stringify(args) });

/** Works on the orders of one multi-order message side by side (4 at a time; no chat history, so they cannot get
 *  mixed up), stores each outcome, and when all are done sends one message: "בוצע ✅" + a line per order + the first
 *  critical question. Orders not reached within ~80 s are left for the next request. */
async function runBatch(phone: string, base: string) {
  const started = Date.now();
  const parts = await db("/rest/v1/wa_messages?select=id,body&direction=eq.in&handled_at=is.null&hidden=is.false&phone=" + eq(phone) +
    "&id=like." + encodeURIComponent(base + "#*") + "&order=created_at");
  let next = 0;
  const worker = async () => {
    while (next < parts.length && Date.now() - started < 80_000) {
      const p = parts[next++];
      let r;
      try { r = await handleBatchPart(deps, { id: base, phone, text: p.body }); }
      catch (e) { console.error("batch part failed", p.id, e); r = { status: "question", text: "לא הצלחתי לפתוח את ההזמנה (" + ((e as Error).message || "שגיאה") + "): \"" + String(p.body).slice(0, 80) + "\". לשלוח אותה שוב?" }; }
      await db("/rest/v1/wa_messages?id=" + eq(p.id), { method: "PATCH", body: JSON.stringify({ handled_at: new Date().toISOString(), started_at: new Date().toISOString(), result: r.status, result_text: r.text }) });
    }
  };
  await Promise.all([1, 2, 3, 4].map(worker));
  const all = await db("/rest/v1/wa_messages?select=id,body,result,result_text,handled_at&direction=eq.in&phone=" + eq(phone) +
    "&id=like." + encodeURIComponent(base + "#*") + "&order=created_at");
  if (all.some((p: any) => !p.handled_at)) return "batch partial";
  // send the summary once, even if two requests get here
  const claimed = await db("/rest/v1/wa_messages?result=is.null&id=" + eq(base), { method: "PATCH", body: JSON.stringify({ result: "summarized" }), headers: { Prefer: "return=representation" } });
  if (!claimed.length) return "batch done";
  const questions = all.filter((p: any) => p.result !== "done");
  if (questions.length) await db("/rest/v1/wa_messages?id=" + eq(questions[0].id), { method: "PATCH", body: JSON.stringify({ asked_at: new Date().toISOString() }) });
  const text = batchSummary(all);
  await send(phone, text);
  await store.saveOutgoing(phone, text);
  return "batch " + all.length;
}

/** Answers the oldest waiting message of the person who sent message `id`, then queues the next one.
 *  Only one request works for a person at a time (wa_claim); others return "busy" and the holder carries on. */
async function answer(id: string) {
  const [first] = await db("/rest/v1/wa_messages?select=phone&id=" + eq(id));
  if (!first) return "skip";
  const phone = first.phone;
  if (!(await rpc("wa_claim", { p_phone: phone }))) return "busy";
  let result = "idle";
  try {
    const m = await rpc("wa_next", { p_phone: phone });
    if (m) {
      const done = () => db("/rest/v1/wa_messages?id=" + eq(m.id), { method: "PATCH", body: JSON.stringify({ handled_at: new Date().toISOString() }) });
      const t0 = Date.now();
      if (m.tries > 3) {
        await done();
        await send(phone, "לא הצלחתי לטפל בהודעה הזו גם אחרי כמה ניסיונות: \"" + String(m.body).slice(0, 60) + "…\". נסו לשלוח אותה שוב, אולי בחלקים.");
        result = "gave up";
      } else if (String(m.id).includes("#")) {
        result = await runBatch(phone, String(m.id).split("#")[0]);
      } else if (maybeSeveralOrders(m.body) && (await splitOrders(deps, m.body).then(async (parts) => {
        if (parts.length < 2) return false;
        await rpc("wa_split", { p_id: m.id, p_parts: parts });
        return true;
      }).catch((e) => { console.error("split failed", e); return false; }))) {
        result = await runBatch(phone, m.id);
      } else {
        try {
          await handleMessage(deps, { id: String(m.id).split("#")[0], phone, text: m.body }, { received: true, current: m.id });
        } catch (e) {
          console.error("assistant error", e);
          await send(phone, "משהו השתבש אצלי (" + ((e as Error).message || "שגיאה") + "). נסו שוב בעוד רגע.");
        }
        await done();
        result = "ok";
      }
      console.log("whatsapp", result, m.id, Date.now() - t0, "ms");
    }
  } finally {
    await rpc("wa_release", { p_phone: phone }).catch(() => {});
  }
  // anything still waiting for this person gets its own request
  const waiting = await db("/rest/v1/wa_messages?select=id&direction=eq.in&hidden=is.false&handled_at=is.null&phone=" + eq(phone) + "&order=created_at&limit=1");
  if (waiting.length) await rpc("wa_enqueue", { p_id: waiting[0].id }).catch((e) => console.error("enqueue failed", e));
  return result;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && env("WHATSAPP_VERIFY_TOKEN") && url.searchParams.get("hub.verify_token") === env("WHATSAPP_VERIFY_TOKEN");
    return ok ? new Response(url.searchParams.get("hub.challenge") || "") : new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const internal = req.headers.get("x-internal-key");
  if (internal) {
    const ok = (await db("/rest/v1/rpc/check_cron_key", { method: "POST", body: JSON.stringify({ p_key: internal }) }).catch(() => false)) === true;
    if (!ok) return new Response("forbidden", { status: 403 });
    const { process: id } = await req.json().catch(() => ({}));
    return new Response(id ? await answer(String(id)) : "missing id");
  }
  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get("x-hub-signature-256")))) return new Response("bad signature", { status: 401 });
  let payload; try { payload = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  const work = intake(payload);
  // @ts-ignore EdgeRuntime exists on Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(work); else await work;
  return new Response("ok");
});
