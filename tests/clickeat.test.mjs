import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseClickEatOrder, withoutPayments } from "../supabase/functions/_shared/clickeat.js";

const fixture = (n) => readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8");

test("delivery email is read completely", () => {
  const { order, problems } = parseClickEatOrder(fixture("clickeat-delivery.html"));
  assert.deepEqual(problems, []);
  assert.equal(order.number, "1201");
  assert.equal(order.delivery_date, "2026-11-17");
  assert.equal(order.time_window, "09:00-16:00");
  assert.equal(order.customer_name, "ישראל ישראלי");
  assert.equal(order.phone, "0500000001");
  assert.equal(order.pickup, false);
  assert.deepEqual(order.address, { city: "תל אביב-יפו", street: "הרצל", building: "10", entrance: "ב", floor: "3", apt: "7" });
  assert.equal(order.items.length, 4);
  assert.deepEqual(order.items[0], { name: "סשימי טונה", count: 4, price: 168, kg: 0.4, note: "אם אפשר לחתוך דק", option: "חתוך" });
  assert.equal(order.items[1].name, "פילה דניס טרי"); // trailing space removed
  assert.equal(order.items[2].option, "טחון");
  assert.deepEqual(order.items[3], { name: "גיוזה עוף", count: 2, price: 60, kg: null, note: "", option: "" });
  assert.equal(order.delivery_fee, 30);
  assert.equal(order.total, 466);
});

test("pickup email has no address and decodes HTML entities", () => {
  const { order, problems } = parseClickEatOrder(fixture("clickeat-pickup.html"));
  assert.deepEqual(problems, []);
  assert.equal(order.pickup, true);
  assert.deepEqual(order.address, {});
  assert.equal(order.items[0].note, "מהחלק העבה & הבטן");
  assert.equal(order.items[0].option, "פילה בלי עור");
});

test("card digits are never read or kept", () => {
  const html = fixture("clickeat-delivery.html");
  assert.ok(html.includes("9999"));
  assert.ok(!JSON.stringify(parseClickEatOrder(html)).includes("9999"));
  assert.ok(!withoutPayments(html).includes("9999"));
});

test("totals that do not add up are reported, not guessed", () => {
  const html = fixture("clickeat-delivery.html").replace("<td>466</td>", "<td>500</td>");
  const { problems } = parseClickEatOrder(html);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /לא תואם/);
});

test("a delivery without an address is reported", () => {
  const html = fixture("clickeat-delivery.html").replace(/<br>\r\n<table[\s\S]*?<\/table>/, "");
  assert.ok(parseClickEatOrder(html).problems.some((p) => p.includes("כתובת")));
});

test("emails that are not orders are recognised", () => {
  assert.equal(parseClickEatOrder("<p>שלום</p>").order, null);
});
