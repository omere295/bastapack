// Money logic for BastaPack. Prices are ₪; amounts are kg (unit "kg") or a count (unit "unit").
//
// Private orders: the website line price covers the ordered amount, so
//   price per kg   = line_price ÷ ordered_kg
//   price per unit = line_price ÷ ordered_count
//   difference     = (final − ordered) × price per unit
// An item added while packing costs final × the product's website price.
// A removed item gives back its whole line price. The delivery fee is never part of the difference.
//
// Business orders: price per unit comes from the client's saved price list.

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const num = (v) => (v == null || v === "" ? null : Number(v));

export function orderedAmount(item) {
  return item.unit === "kg" ? num(item.ordered_kg) : num(item.ordered_count);
}

/** ₪ per kg / per unit for a private-order item, or null when unknown. */
export function privateUnitPrice(item, product) {
  if (item.added_during_packing) return product && product.site_price != null ? Number(product.site_price) : null;
  const lp = num(item.line_price), ord = orderedAmount(item);
  if (lp == null || !ord) return null;
  return lp / ord;
}

/** Price difference for one private item (positive = customer owes more). */
export function privateItemDiff(item, product) {
  if (item.removed_at) return item.added_during_packing ? 0 : round2(-(num(item.line_price) || 0));
  if (!item.confirmed || item.final_amount == null) return 0;
  const p = privateUnitPrice(item, product);
  if (p == null) return 0;
  const fin = Number(item.final_amount);
  return round2(item.added_during_packing ? fin * p : (fin - orderedAmount(item)) * p);
}

/** Total price difference for a private order. productsById maps product id → product. */
export function privateOrderDiff(items, productsById = {}) {
  return round2(items.reduce((s, it) => s + privateItemDiff(it, productsById[it.product_id]), 0));
}

/**
 * Business order total before VAT. Uses final amounts where confirmed, otherwise ordered amounts.
 * prices maps product id → client price. Returns {total, missing: [item names without a price]}.
 */
export function businessTotal(items, prices = {}) {
  let total = 0;
  const missing = [];
  for (const it of items) {
    if (it.removed_at) continue;
    const p = it.product_id != null ? prices[it.product_id] : undefined;
    if (p == null) { missing.push(it.name); continue; }
    const amt = it.confirmed && it.final_amount != null ? Number(it.final_amount) : orderedAmount(it) || 0;
    total += amt * Number(p);
  }
  return { total: round2(total), missing };
}

/** "₪1,234.50" / "−₪12" */
export function formatShekel(n) {
  const v = round2(Math.abs(n));
  const s = v.toLocaleString("he-IL", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return (n < 0 ? "−" : "") + "₪" + s;
}

/** Parses a weight or count typed by staff ("0,45" works too). Returns {value} or {error}. */
export function parseAmount(raw, unit) {
  const s = String(raw == null ? "" : raw).trim().replace(",", ".");
  if (s === "") return { error: unit === "kg" ? "הזינו משקל" : "הזינו כמות" };
  const v = Number(s);
  if (!Number.isFinite(v)) return { error: "מספר לא תקין" };
  if (unit === "unit" && (!Number.isInteger(v) || v < 0)) return { error: "כמות צריכה להיות מספר שלם" };
  if (unit === "kg" && (v <= 0 || v > 200)) return { error: "משקל בין 0.01 ל-200 ק״ג" };
  return { value: v };
}
