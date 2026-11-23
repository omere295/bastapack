// One-click WhatsApp maintenance link (opened by the owner in a browser).
// Connects the WhatsApp Business Account to the app so real messages reach the `whatsapp` webhook
// (POST /{waba}/subscribed_apps), and reports what Meta says.
// Usage: /functions/v1/wa-setup?key=<WHATSAPP_VERIFY_TOKEN>&waba=<WhatsApp Business Account id>
// Results are also written to the function log.

const env = (k: string) => Deno.env.get(k) || "";
const GRAPH = "https://graph.facebook.com/" + (env("WHATSAPP_API_VERSION") || "v23.0");

async function graph(path: string, method = "GET") {
  const r = await fetch(GRAPH + path, { method, headers: { Authorization: "Bearer " + env("WHATSAPP_TOKEN") } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!env("WHATSAPP_VERIFY_TOKEN") || url.searchParams.get("key") !== env("WHATSAPP_VERIFY_TOKEN")) return new Response("forbidden", { status: 403 });
  const waba = (url.searchParams.get("waba") || "").replace(/\D/g, "");
  if (!waba) return new Response("missing waba", { status: 400 });
  const out = {
    phone: await graph("/" + env("WHATSAPP_PHONE_NUMBER_ID") + "?fields=display_phone_number,verified_name,status,platform_type"),
    before: await graph("/" + waba + "/subscribed_apps"),
    subscribe: await graph("/" + waba + "/subscribed_apps", "POST"),
    after: await graph("/" + waba + "/subscribed_apps"),
  };
  console.log("wa-setup", JSON.stringify(out));
  const ok = out.subscribe.status === 200 && out.subscribe.body?.success;
  return new Response((ok ? "✅ חובר. שלחו הודעה לאמילי עכשיו.\n\n" : "❌ לא הצליח. שלחו צילום מסך של הדף הזה.\n\n") + JSON.stringify(out, null, 2),
    { headers: { "content-type": "text/plain; charset=utf-8" } });
});
