import { test } from "node:test";
import assert from "node:assert/strict";
import { todayIL, addDays, weekday, isDeliveryDay, isOpenDay, nextDeliveryDay, dayParts, dayLabel } from "../web/lib/days.js";
import { privateUnitPrice, privateItemDiff, privateOrderDiff, businessTotal, parseAmount, formatShekel, round2 } from "../web/lib/money.js";
import { buildCsv, csvCell } from "../web/lib/csv.js";

// ---------- days ----------
test("today is computed in Israel time", () => {
  // 23:30 UTC on 26/10 is already 27/10 in Israel (UTC+2)
  assert.equal(todayIL(new Date("2026-10-26T23:30:00Z")), "2026-10-27");
});

test("working days: Mon–Fri deliver, Sunday pickup only, Saturday closed", () => {
  assert.equal(weekday("2026-11-15"), 0);           // Sunday
  assert.equal(isDeliveryDay("2026-11-15"), false);
  assert.equal(isOpenDay("2026-11-15"), true);
  assert.equal(isOpenDay("2026-11-14"), false);       // Saturday
  assert.equal(isDeliveryDay("2026-11-20"), true);    // Friday
  assert.equal(isDeliveryDay("2026-11-16", ["2026-11-16"]), false); // holiday
});

test("next delivery day skips the weekend and holidays", () => {
  assert.equal(nextDeliveryDay("2026-11-20"), "2026-11-23");                    // Fri → Mon
  assert.equal(nextDeliveryDay("2026-11-15", { inclusive: true }), "2026-11-16"); // Sun → Mon
  assert.equal(nextDeliveryDay("2026-11-17", { holidays: ["2026-11-18"] }), "2026-11-19");
});

test("day labels put Today/Tomorrow first", () => {
  assert.deepEqual(dayParts("2026-10-27", "2026-10-27"), { rel: "היום", base: "שלישי 27/10" });
  assert.equal(dayLabel("2026-10-28", "2026-10-27"), "מחר · רביעי 28/10");
  assert.equal(dayLabel("2026-10-29", "2026-10-27"), "חמישי 29/10");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

// ---------- money: private (numbers from real ClickEat orders) ----------
const tuna = { unit: "kg", ordered_count: 4, ordered_kg: 0.4, line_price: 168, confirmed: true, final_amount: 0.45 };

test("private price per kg = line price ÷ ordered kg", () => {
  assert.equal(privateUnitPrice(tuna), 420);
  assert.equal(round2(privateUnitPrice({ unit: "kg", ordered_kg: 0.66, line_price: 156 })), 236.36);
});

test("private difference for extra and missing weight", () => {
  assert.equal(privateItemDiff(tuna), 21);                                     // +50 g × ₪420
  assert.equal(privateItemDiff({ ...tuna, final_amount: 0.38 }), -8.4);        // −20 g
  assert.equal(privateItemDiff({ ...tuna, confirmed: false }), 0);             // not weighed yet
});

test("private difference for per-unit items, added items and removed items", () => {
  const gyoza = { unit: "unit", ordered_count: 2, line_price: 60, confirmed: true, final_amount: 3 };
  assert.equal(privateItemDiff(gyoza), 30);
  const added = { unit: "kg", added_during_packing: true, confirmed: true, final_amount: 0.2, product_id: "p" };
  assert.equal(privateItemDiff(added, { site_price: 155 }), 31);
  assert.equal(privateItemDiff({ ...tuna, removed_at: "2026-11-15" }), -168);
  assert.equal(privateOrderDiff([tuna, gyoza, { ...added }], { p: { site_price: 155 } }), 82);
});

test("business total uses client prices and lists missing ones", () => {
  const items = [
    { product_id: "a", name: "סלמון", unit: "kg", ordered_kg: 6, confirmed: true, final_amount: 6.15 },
    { product_id: "b", name: "טונה", unit: "kg", ordered_kg: 2, confirmed: false },
    { product_id: "c", name: "פונזו", unit: "unit", ordered_count: 6 },
    { product_id: "d", name: "הוסר", unit: "kg", ordered_kg: 1, removed_at: "x" },
  ];
  assert.deepEqual(businessTotal(items, { a: 128, b: 360 }), { total: 1507.2, missing: ["פונזו"] });
});

test("amount parsing accepts commas and rejects bad input", () => {
  assert.deepEqual(parseAmount("0,45", "kg"), { value: 0.45 });
  assert.ok(parseAmount("", "kg").error);
  assert.ok(parseAmount("1.5", "unit").error);
  assert.ok(parseAmount("0", "kg").error);
  assert.deepEqual(parseAmount("0", "unit"), { value: 0 });
});

test("shekel formatting", () => {
  assert.equal(formatShekel(21), "₪21");
  assert.equal(formatShekel(-8.4), "−₪8.40");
});

// ---------- csv ----------
test("CSV puts Private, two empty lines, then Business", () => {
  const cols = [{ key: "num", label: "מספר" }, { key: "addr", label: "כתובת" }];
  const text = buildCsv([[{ num: "981", addr: "פלורנטין 18, תל אביב" }], [{ num: "B-1001", addr: 'אלנבי "64"' }]], cols);
  const lines = text.replace(/^﻿/, "").split("\r\n");
  assert.deepEqual(lines, ["מספר,כתובת", '981,"פלורנטין 18, תל אביב"', "", "", "מספר,כתובת", 'B-1001,"אלנבי ""64"""']);
  assert.ok(text.startsWith("﻿"));
  assert.equal(csvCell(null), "");
});
