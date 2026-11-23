// Delivery route for one day. Called by the app (any staff login).
//   {action: "optimize", day}          → find every address and put the stops in the quickest driving order
//   {action: "reorder", day, order}    → keep the order staff chose and recalculate the drive times
// Starts at the shop address (settings). Ends back at the shop, at the last stop, or at a custom address
// (settings: route_end = shop | last_stop | custom, route_end_address).
// Uses Google Geocoding (results cached) and Google Routes (computeRoutes). Secret: GOOGLE_MAPS_API_KEY.
// Up to 25 stops Google picks the order. Above that a rough order comes from straight-line distances
// (nearest neighbour + 2-opt) and Google then orders each run of 25. "Last stop" mode tries the 3 furthest stops
// as the end and keeps the quickest. Addresses Google only guessed at (other street/city, too far) count as not found.

const KEY = Deno.env.get("GOOGLE_MAPS_API_KEY");
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
class UserError extends Error {}
type P = { lat: number; lng: number; formatted?: string };
/** Straight-line km between two points. */
function dist(a: P, b: P) { const x = (b.lng - a.lng) * Math.PI / 180 * Math.cos((a.lat + b.lat) * Math.PI / 360), y = (b.lat - a.lat) * Math.PI / 180; return 6371 * Math.hypot(x, y); }

function roleOf(req: Request) {
  try {
    const t = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
    return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")))?.app_metadata?.role ?? null;
  } catch { return null; }
}
async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(SB_URL + path, { ...init, headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", ...(init.headers || {}) } });
  const t = await res.text(); const d = t ? JSON.parse(t) : null;
  if (!res.ok) throw new UserError((d && d.message) || "שגיאת מסד נתונים");
  return d;
}

// ---------- Google ----------
const SHOP_AREA = { lat: 32.0626, lng: 34.7761 };
const MAX_KM = 45; // nothing we deliver to is further than this from the shop
const loose = (t: string) => String(t || "").replace(/[-־"'״׳().,]/g, " ").replace(/\s+/g, " ").trim();
/** A Google answer we can trust: in Israel, close enough, and, when Google only guessed (partial match),
 *  the street and city it found are the ones we asked for. Wrong guesses are what made routes look odd. */
function trusted(res: any, query: string) {
  if (!res || res.geometry?.location_type === "APPROXIMATE") return false;
  const c = (t: string) => (res.address_components || []).find((x: any) => x.types?.includes(t));
  if (c("country")?.short_name && c("country").short_name !== "IL") return false;
  const loc = res.geometry?.location; if (!loc || dist(SHOP_AREA, { lat: loc.lat, lng: loc.lng }) > MAX_KM) return false;
  if (!res.partial_match) return true;
  const [streetPart, cityPart] = query.split(",").map((x) => loose(x));
  const route = loose(c("route")?.long_name || ""), city = loose(c("locality")?.long_name || "");
  const words = (t: string) => t.split(" ").filter(Boolean).sort().join(" "); // "לסר אורי" = "אורי לסר"
  const streetOk = !!route && words(route) === words(streetPart.replace(/\s*\d.*$/, ""));
  const cityOk = !cityPart || !city || city.includes(cityPart) || cityPart.includes(city);
  return streetOk && cityOk && !!c("street_number");
}
async function geocode(query: string): Promise<P | null> {
  const [hit] = await db("/rest/v1/geocode_cache?query=eq." + encodeURIComponent(query) + "&select=*");
  if (hit && (hit.ok || Date.now() - Date.parse(hit.updated_at) < 6 * 3600_000)) return hit.ok ? { lat: hit.lat, lng: hit.lng, formatted: hit.formatted } : null;
  const r = await fetch("https://maps.googleapis.com/maps/api/geocode/json?region=il&language=he&components=country:IL&address=" + encodeURIComponent(query) + "&key=" + KEY);
  const d = await r.json();
  if (d.status === "REQUEST_DENIED" || d.status === "OVER_QUERY_LIMIT") throw new UserError("Google סירב לחיפוש כתובת: " + (d.error_message || d.status));
  const res = d.status === "OK" ? d.results[0] : null;
  const ok = trusted(res, query);
  const row = { query, ok, lat: res?.geometry?.location?.lat ?? null, lng: res?.geometry?.location?.lng ?? null, formatted: res?.formatted_address ?? null, updated_at: new Date().toISOString() };
  await db("/rest/v1/geocode_cache?on_conflict=query", { method: "POST", body: JSON.stringify(row), headers: { Prefer: "resolution=merge-duplicates" } });
  return ok ? { lat: row.lat, lng: row.lng, formatted: row.formatted } : null;
}

const wp = (p: P) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
const secs = (d?: string) => (d ? parseInt(d, 10) || 0 : 0);
async function computeRoute(origin: P, destination: P, inter: P[], optimize: boolean) {
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY!, "X-Goog-FieldMask": "routes.optimizedIntermediateWaypointIndex,routes.legs.duration,routes.legs.distanceMeters" },
    body: JSON.stringify({ origin: wp(origin), destination: wp(destination), intermediates: inter.map(wp), travelMode: "DRIVE", routingPreference: "TRAFFIC_UNAWARE", optimizeWaypointOrder: optimize && inter.length > 1, languageCode: "he", units: "METRIC" }),
  });
  const d = await r.json();
  if (!r.ok || !d.routes?.length) throw new UserError("Google לא החזיר מסלול: " + (d.error?.message || r.status));
  const route = d.routes[0];
  const legs = (route.legs || []).map((l: any) => ({ seconds: secs(l.duration), meters: l.distanceMeters || 0 }));
  return { order: (route.optimizedIntermediateWaypointIndex || []).filter((i: number) => i >= 0) as number[], legs, total: legs.reduce((s: number, l: any) => s + l.seconds, 0) };
}
/** Drive times for a fixed order, in pieces of up to 25 stops. */
async function legsFor(points: P[]) {
  const legs: { seconds: number; meters: number }[] = [];
  for (let i = 0; i < points.length - 1; i += 26) {
    const chunk = points.slice(i, Math.min(i + 27, points.length));
    if (chunk.length < 2) break;
    legs.push(...(await computeRoute(chunk[0], chunk[chunk.length - 1], chunk.slice(1, -1), false)).legs);
  }
  return legs;
}

// ---------- order without Google (more than 25 stops) ----------
function heuristicOrder(start: P, stops: P[], end: P | null) {
  const left = stops.map((_, i) => i), tour: number[] = [];
  let cur = start;
  while (left.length) { let bi = 0; left.forEach((s, k) => { if (dist(cur, stops[s]) < dist(cur, stops[left[bi]])) bi = k; }); tour.push(left[bi]); cur = stops[left[bi]]; left.splice(bi, 1); }
  const pt = (k: number) => (k < 0 ? start : k >= tour.length ? end : stops[tour[k]]);
  const len = () => { let s = 0; for (let k = -1; k < tour.length; k++) { const a = pt(k), b = pt(k + 1); if (a && b) s += dist(a, b); } return s; };
  for (let improved = true, guard = 0; improved && guard < 50; guard++) {
    improved = false;
    for (let i = 0; i < tour.length - 1; i++) for (let j = i + 1; j < tour.length; j++) {
      const before = len(); const seg = tour.slice(i, j + 1).reverse(); tour.splice(i, seg.length, ...seg);
      if (len() + 1e-9 < before) improved = true; else tour.splice(i, seg.length, ...seg.reverse());
    }
  }
  return tour;
}

// ---------- main ----------
const addrQuery = (a: any) => a && a.street ? [String(a.street) + (a.building ? " " + a.building : ""), a.city || "תל אביב", "ישראל"].join(", ") : null;

async function build(day: string, wanted: string[] | null) {
  if (!KEY) throw new UserError("מפתח Google Maps עוד לא הוגדר ב-Supabase");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new UserError("תאריך לא תקין");
  const settings = Object.fromEntries((await db("/rest/v1/settings?select=key,value")).map((s: any) => [s.key, s.value]));
  const endMode = ["last_stop", "custom"].includes(settings.route_end) ? settings.route_end : "shop";
  const shop = await geocode(String(settings.shop_address || "מקווה ישראל 22, תל אביב") + ", ישראל");
  if (!shop) throw new UserError("לא נמצאה כתובת החנות. בדקו אותה בהגדרות.");
  const endLabel = endMode === "custom" ? String(settings.route_end_address || "").trim() : null;
  if (endMode === "custom" && !endLabel) throw new UserError("בחרתם לסיים בכתובת אחרת אבל לא הוזנה כתובת. הוסיפו אותה בהגדרות.");
  const endP: P | null = endMode === "shop" ? shop : endMode === "custom" ? await geocode(endLabel + ", ישראל") : null;
  if (endMode === "custom" && !endP) throw new UserError("כתובת סיום המסלול לא נמצאה במפה: " + endLabel);
  const orders = await db("/rest/v1/orders?select=id,kind,address,clients(address)&deleted_at=is.null&pickup=is.false&delivery_date=eq." + day);
  const found: { id: string; p: P }[] = []; const unfound: string[] = [];
  for (const o of orders) {
    const q = addrQuery(o.kind === "business" ? o.clients?.address : o.address);
    const p = q ? await geocode(q) : null;
    if (p) found.push({ id: o.id, p }); else unfound.push(o.id);
  }
  let seq: number[];
  let legs: { seconds: number; meters: number }[] = [];
  if (wanted) {
    const pos = new Map(wanted.map((id, i) => [id, i]));
    seq = found.map((_, i) => i).sort((a, b) => (pos.get(found[a].id) ?? 1e9) - (pos.get(found[b].id) ?? 1e9));
  } else if (found.length <= 1) seq = found.map((_, i) => i);
  else if (endP && found.length <= 25) {
    const r = await computeRoute(shop, endP, found.map((f) => f.p), true);
    seq = r.order.length === found.length ? r.order : found.map((_, i) => i); legs = r.order.length === found.length ? r.legs : [];
  } else if (endMode === "last_stop" && found.length <= 26) {
    // Google needs a fixed end point, so try the 3 stops furthest from the shop as the last stop and keep the quickest.
    const cands = found.map((_, i) => i).sort((a, b) => dist(shop, found[b].p) - dist(shop, found[a].p)).slice(0, 3);
    let best: { seq: number[]; legs: any[]; total: number } | null = null;
    for (const far of cands) {
      const rest = found.map((_, i) => i).filter((i) => i !== far);
      const r = await computeRoute(shop, found[far].p, rest.map((i) => found[i].p), true);
      if (r.order.length !== rest.length && rest.length > 1) continue;
      const s2 = (rest.length > 1 ? r.order.map((k) => rest[k]) : rest).concat(far);
      if (!best || r.total < best.total) best = { seq: s2, legs: r.legs, total: r.total };
    }
    seq = best ? best.seq : heuristicOrder(shop, found.map((f) => f.p), null); legs = best ? best.legs : [];
  } else {
    // More than 25 stops: a rough order first, then Google puts each run of up to 25 stops in the best driving order.
    const rough = heuristicOrder(shop, found.map((f) => f.p), endP);
    seq = [];
    for (let i = 0; i < rough.length; i += 25) {
      const chunk = rough.slice(i, i + 25);
      const from = seq.length ? found[seq[seq.length - 1]].p : shop;
      const next = rough[i + 25];
      const to = next !== undefined ? found[next].p : endP;
      if (!to || chunk.length < 2) { seq.push(...chunk); continue; }
      const r = await computeRoute(from, to, chunk.map((k) => found[k].p), true);
      seq.push(...(r.order.length === chunk.length ? r.order.map((k) => chunk[k]) : chunk));
    }
  }
  const path = [shop, ...seq.map((i) => found[i].p), ...(endP ? [endP] : [])];
  if (!legs.length && path.length > 1) legs = await legsFor(path);
  const row = {
    day, stop_ids: [...seq.map((i) => found[i].id), ...unfound], legs, unfound, end_mode: endMode, end_label: endLabel, optimized: !wanted,
    points: Object.fromEntries(found.map((f) => [f.id, f.p])),
    total_seconds: legs.reduce((s, l) => s + l.seconds, 0), total_meters: legs.reduce((s, l) => s + l.meters, 0), computed_at: new Date().toISOString(),
  };
  await db("/rest/v1/delivery_routes?on_conflict=day", { method: "POST", body: JSON.stringify(row), headers: { Prefer: "resolution=merge-duplicates" } });
  return row;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!["admin", "employee"].includes(roleOf(req))) return json({ error: "אין הרשאה" }, 403);
  try {
    const b = await req.json();
    if (b.action === "optimize") return json(await build(String(b.day), null));
    if (b.action === "reorder" && Array.isArray(b.order)) return json(await build(String(b.day), b.order.map(String)));
    return json({ error: "פעולה לא מוכרת" }, 400);
  } catch (e) {
    return json({ error: e instanceof UserError ? e.message : "שגיאה: " + (e as Error).message }, e instanceof UserError ? 400 : 500);
  }
});
