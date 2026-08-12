const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { tokenNumberForTime, validateSlotAgainstSchedule, defaultWeeklyHours, slotKey } = require("../../src/utils/time");
const { extractWebhookMessages, verifyMetaSignature, verifyWebhookToken } = require("../../src/services/whatsappService");
const { createApp } = require("../../src/app");
const { config } = require("../../src/config/env");
const { formatAppointmentId } = require("../../src/services/appointmentService");
const { languageMessage, mainMenu } = require("../../src/conversation/messages");
const { tr } = require("../../src/conversation/translations");

const location = { _id: "location", code: "BWP", timezone: "Asia/Karachi", slotDurationMinutes: 15, weeklyHours: defaultWeeklyHours() };
test("appointment IDs use Sohaib format", () => assert.equal(formatAppointmentId("bwp", 2026, 1), "DS-2026-0001"));
test("tokens follow appointment time order", () => { assert.equal(tokenNumberForTime(location, "2026-08-10", "16:30"), "001"); assert.equal(tokenNumberForTime(location, "2026-08-10", "17:00"), "003"); });
test("tokens reject off-grid times", () => assert.equal(tokenNumberForTime(location, "2026-08-10", "16:40"), ""));
test("location is part of slot uniqueness key", () => assert.notEqual(slotKey("a", "2026-08-10", "16:30"), slotKey("b", "2026-08-10", "16:30")));
test("closed dates are rejected", () => assert.equal(validateSlotAgainstSchedule({ settings: location, date: "2026-08-14", time: "16:30", now: require("luxon").DateTime.fromISO("2026-08-01", { zone: "Asia/Karachi" }) }).ok, false));
test("past dates are rejected", () => assert.match(validateSlotAgainstSchedule({ settings: location, date: "2026-07-01", time: "16:30", now: require("luxon").DateTime.fromISO("2026-08-01", { zone: "Asia/Karachi" }) }).reason, /Past/));
test("interactive button IDs are parsed independently from titles", () => { const x = extractWebhookMessages({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.1", from: "923001234567", type: "interactive", interactive: { button_reply: { id: "MENU_BOOK", title: "Book Appointment" } } }] } }] }] }).messages[0]; assert.equal(x.replyId, "MENU_BOOK"); assert.equal(x.replyTitle, "Book Appointment"); });
test("interactive list IDs are parsed", () => { const x = extractWebhookMessages({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.2", from: "923001234567", type: "interactive", interactive: { list_reply: { id: "LOCATION_BWP", title: "Iqbal Hospital" } } }] } }] }] }).messages[0]; assert.equal(x.replyId, "LOCATION_BWP"); });
test("media IDs are parsed", () => { const x = extractWebhookMessages({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.3", from: "923001234567", type: "image", image: { id: "media-1" } }] } }] }] }).messages[0]; assert.equal(x.mediaId, "media-1"); });
test("webhook signatures are verified", () => { const crypto = require("node:crypto"); const body = Buffer.from('{"test":true}'); const signature = `sha256=${crypto.createHmac("sha256", "secret").update(body).digest("hex")}`; assert.equal(verifyMetaSignature(body, signature, "secret"), true); assert.equal(verifyMetaSignature(body, signature, "wrong"), false); });
test("webhook delivery fails closed when the Meta app secret is absent", () => {
  assert.equal(verifyMetaSignature(Buffer.from("{}"), "sha256=invalid", ""), false);
});
test("webhook verification tokens tolerate surrounding whitespace but reject empty or incorrect values", () => {
  assert.equal(verifyWebhookToken("  correct-token\r\n", "correct-token"), true);
  assert.equal(verifyWebhookToken("wrong-token", "correct-token"), false);
  assert.equal(verifyWebhookToken("", ""), false);
});
test("Meta dotted verification query bypasses sanitization and returns only the challenge", async () => {
  const originalToken = config.whatsapp.verifyToken;
  config.whatsapp.verifyToken = "route-verification-token";
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const endpoint = `http://127.0.0.1:${port}/api/whatsapp/webhook`;
    const accepted = await fetch(`${endpoint}?hub.mode=subscribe&hub.verify_token=route-verification-token&hub.challenge=123456`);
    assert.equal(accepted.status, 200);
    assert.equal(await accepted.text(), "123456");
    const denied = await fetch(`${endpoint}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123456`);
    assert.equal(denied.status, 403);
    const invalidDelivery = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=invalid" },
      body: "{}"
    });
    assert.equal(invalidDelivery.status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/server.js`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/src/config/env.js`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/package.json`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    config.whatsapp.verifyToken = originalToken;
  }
});
test("language selection uses stable IDs", () => assert.deepEqual(languageMessage().buttons.map((x) => x.id), ["LANG_EN", "LANG_UR"]));
test("main menu uses an interactive list", () => { const menu = mainMenu("en"); assert.equal(menu.kind, "list"); assert.equal(menu.sections[0].rows.length, 6); });
test("Urdu booking content does not fall back to English", () => assert.match(tr("ur", "name"), /[\u0600-\u06FF]/));
