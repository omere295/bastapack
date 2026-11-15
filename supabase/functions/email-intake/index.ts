// Receives ClickEat order emails from the Google Apps Script in the shop's Gmail
// (integrations/gmail-to-bastapack.gs) and turns them into Private orders.
//
// Request:  POST, header "x-intake-secret: <INTAKE_SECRET>",
//           body {messages: [{id, subject, date, from, html}]}
// Response: {results: [{id, status, problem?}]} — status is imported / updated / review / duplicate.
// The script labels a message as done only after it appears in results.

import { parseClickEatOrder, withoutPayments } from "../_shared/clickeat.js";

const SENDER = "noreply@click-eat.co.il";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const secret = Deno.env.get("INTAKE_SECRET");
  if (!secret || req.headers.get("x-intake-secret") !== secret) return json({ error: "unauthorized" }, 401);

  let body: { messages?: Array<{ id: string; subject?: string; date?: string; from?: string; html?: string }> };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const messages = (body.messages || []).slice(0, 50);

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const results = [];
  for (const m of messages) {
    if (!m || !m.id) continue;
    let parsed = null, problem: string | null = null;
    if (!String(m.from || "").toLowerCase().includes(SENDER)) problem = "המייל לא נשלח מהאתר (" + (m.from || "שולח לא ידוע") + ")";
    else {
      const r = parseClickEatOrder(m.html || "");
      parsed = r.order;
      if (r.problems.length) problem = r.problems.join(" · ");
    }
    const res = await fetch(url + "/rest/v1/rpc/ingest_email", {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_gmail_id: m.id, p_subject: m.subject || null, p_received: m.date || null,
        p_parsed: parsed, p_problem: problem, p_html: problem ? withoutPayments(m.html || "").slice(0, 200000) : null,
      }),
    });
    if (!res.ok) { results.push({ id: m.id, status: "error", problem: (await res.text()).slice(0, 300) }); continue; }
    const out = await res.json();
    results.push({ id: m.id, status: out.duplicate ? "duplicate" : out.status, problem: out.problem || undefined });
  }
  return json({ results });
});
