/**
 * BastaPack — sends new ClickEat order emails from this Gmail account to the app.
 *
 * One-time setup (about 3 minutes):
 *  1. Go to script.google.com while signed in to the shop's Gmail → New project.
 *  2. Delete what's there and paste this whole file. Name the project "BastaPack email".
 *  3. Project Settings (gear icon) → Script properties → Add property:
 *       INTAKE_SECRET = the same passphrase you entered in Supabase
 *  4. Back in the editor, choose the function "setup" at the top and click Run.
 *     Google will ask for permission to read and label Gmail — allow it.
 * After that it runs by itself every minute. Processed emails get the Gmail label "BastaPack".
 */

const INTAKE_URL = "https://hpfxgqsgshglaiwrtogb.supabase.co/functions/v1/email-intake";
const QUERY = "from:noreply@click-eat.co.il -label:BastaPack newer_than:14d";
const LABEL = "BastaPack";

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendNewOrders").timeBased().everyMinutes(1).create();
  GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  sendNewOrders();
}

function sendNewOrders() {
  const secret = PropertiesService.getScriptProperties().getProperty("INTAKE_SECRET");
  if (!secret) throw new Error("Missing INTAKE_SECRET in Project Settings → Script properties");
  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  const threads = GmailApp.search(QUERY, 0, 20);
  if (!threads.length) return;

  const messages = [];
  const byId = {};
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      if (m.getFrom().toLowerCase().indexOf("noreply@click-eat.co.il") < 0) return;
      messages.push({ id: m.getId(), subject: m.getSubject(), date: m.getDate().toISOString(), from: m.getFrom(), html: m.getBody() });
      byId[m.getId()] = t;
    });
  });
  if (!messages.length) return;

  const res = UrlFetchApp.fetch(INTAKE_URL, {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { "x-intake-secret": secret }, payload: JSON.stringify({ messages: messages }),
  });
  if (res.getResponseCode() !== 200) throw new Error("BastaPack answered " + res.getResponseCode() + ": " + res.getContentText());

  // Label a thread only when every message in it was handled, so nothing is skipped.
  const done = {};
  JSON.parse(res.getContentText()).results.forEach(function (r) { if (r.status !== "error") done[r.id] = true; });
  threads.forEach(function (t) {
    const ok = t.getMessages().every(function (m) { return m.getFrom().toLowerCase().indexOf("noreply@click-eat.co.il") < 0 || done[m.getId()]; });
    if (ok) t.addLabel(label);
  });
}
