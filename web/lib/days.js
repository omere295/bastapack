// Day logic for BastaPack. All dates are ISO strings "YYYY-MM-DD" in Israel time.
// Mon–Fri: deliveries and pickups. Sunday: self-pickup only. Saturday: closed. Holidays: closed.

export const TZ = "Asia/Jerusalem";
export const DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

/** Today's date in Israel, as "YYYY-MM-DD". */
export function todayIL(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const toUTC = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };

export function addDays(iso, n) {
  const d = toUTC(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday */
export const weekday = (iso) => toUTC(iso).getUTCDay();

export function isDeliveryDay(iso, holidays = []) {
  const w = weekday(iso);
  return w >= 1 && w <= 5 && !holidays.includes(iso);
}

export function isOpenDay(iso, holidays = []) {
  return weekday(iso) !== 6 && !holidays.includes(iso);
}

/** The next delivery day on or after (inclusive) / strictly after the given day. */
export function nextDeliveryDay(iso, { inclusive = false, holidays = [] } = {}) {
  let d = inclusive ? iso : addDays(iso, 1);
  for (let i = 0; i < 60 && !isDeliveryDay(d, holidays); i++) d = addDays(d, 1);
  return d;
}

/** {rel, base}: rel is "היום" / "מחר" / "", base is e.g. "שלישי 27/10". */
export function dayParts(iso, today = todayIL()) {
  const d = toUTC(iso);
  const base = DAY_NAMES[weekday(iso)] + " " + d.getUTCDate() + "/" + (d.getUTCMonth() + 1);
  const rel = iso === today ? "היום" : iso === addDays(today, 1) ? "מחר" : "";
  return { rel, base };
}

export function dayLabel(iso, today = todayIL()) {
  const p = dayParts(iso, today);
  return (p.rel ? p.rel + " · " : "") + p.base;
}

/** Open days from today onwards, for date pickers. */
export function upcomingOpenDays(count, today = todayIL(), holidays = []) {
  const out = [];
  let d = today;
  for (let i = 0; out.length < count && i < 120; i++) {
    if (isOpenDay(d, holidays)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}
