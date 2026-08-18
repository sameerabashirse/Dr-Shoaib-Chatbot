const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.CORS_ORIGINS = "https://clinic.example";
process.env.FRONTEND_URL = "https://clinic.example";
process.env.META_APP_SECRET = "whatsapp-test-secret";
process.env.WHATSAPP_VERIFY_TOKEN = "whatsapp-verify-token";
process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-access-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMATION = "dr_sohaib_appointment_confirmation_v1";
process.env.WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMATION_LANGUAGE = "en_US";
process.env.WHATSAPP_TEMPLATE_APPOINTMENT_REMINDER = "dr_sohaib_appointment_reminder_v1";
process.env.WHATSAPP_TEMPLATE_APPOINTMENT_REMINDER_LANGUAGE = "en_US";
process.env.WHATSAPP_TEMPLATE_RESCHEDULE_CONFIRMATION = "dr_sohaib_reschedule_confirmation_v1";
process.env.WHATSAPP_TEMPLATE_RESCHEDULE_CONFIRMATION_LANGUAGE = "en_US";
process.env.WHATSAPP_TEMPLATE_CANCELLATION_CONFIRMATION = "dr_sohaib_cancellation_confirmation_v1";
process.env.WHATSAPP_TEMPLATE_CANCELLATION_CONFIRMATION_LANGUAGE = "en_US";

const { createApp } = require("../src/app");
const { handleIncomingMessage } = require("../src/conversation/orchestrator");
const {
  setMetaFetchForTests, sendStaffMessage, sendText, updateDeliveryStatus
} = require("../src/services/whatsappService");
const { createAppointment } = require("../src/services/appointmentService");
const { ensureInitialLocations } = require("../src/services/locationService");
const {
  Appointment, AuditLog, BookingRequest, ClinicLocation, ConversationSession,
  MessageDeliveryStatus, Patient, PatientConsent, ReminderJob, RescheduleHistory, WhatsAppMessage, Counter,
  EmergencyAlert
} = require("../src/models");

let mongod;
let server;
let baseUrl;
let metaRequests = [];
let metaSequence = 0;

function successfulMetaFetch() {
  setMetaFetchForTests(async (url, options) => {
    const payload = JSON.parse(options.body);
    metaRequests.push({ url, payload });
    if (payload.status === "read") return new Response(JSON.stringify({ success: true }), { status: 200 });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${++metaSequence}` }] }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  });
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for asynchronous webhook processing.");
}

function signedBody(body) {
  const raw = JSON.stringify(body);
  return { raw, signature: `sha256=${crypto.createHmac("sha256", process.env.META_APP_SECRET).update(raw).digest("hex")}` };
}

async function postWebhook(body, signatureOverride) {
  const signed = signedBody(body);
  const response = await fetch(`${baseUrl}/api/whatsapp/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signatureOverride || signed.signature },
    body: signed.raw
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

function incomingWebhook({ id, phone = "923001234567", text, replyId, replyTitle = "Selection" }) {
  const message = replyId
    ? { id, from: phone, type: "interactive", interactive: { button_reply: { id: replyId, title: replyTitle } } }
    : { id, from: phone, type: "text", text: { body: text } };
  return { object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages: [message] } }] }] };
}

async function reachBookingReview(phone = "+923001234567") {
  let reply = await handleIncomingMessage({ phoneE164: phone, text: "I need an appointment on Monday", messageId: "direct-book" });
  assert.match(reply.body, /full name/i);
  reply = await handleIncomingMessage({ phoneE164: phone, text: "WhatsApp Test Patient", messageId: "direct-name" });
  assert.match(reply.body, /what would you like/i);
  reply = await handleIncomingMessage({ phoneE164: phone, text: "Knee pain follow-up", messageId: "direct-reason" });
  const timeId = reply.buttons.find((button) => button.id.startsWith("AI_TIME_")).id;
  reply = await handleIncomingMessage({ phoneE164: phone, text: "Time", replyId: timeId, messageId: "direct-time" });
  assert.equal(reply.buttons[0].id, "AI_REPORTS_YES");
  reply = await handleIncomingMessage({ phoneE164: phone, text: "No reports", replyId: "AI_REPORTS_NO", messageId: "direct-reports" });
  assert.match(reply.body, /Visit Summary/i);
  reply = await handleIncomingMessage({ phoneE164: phone, text: "Correct", replyId: "AI_SUMMARY_OK", messageId: "direct-summary" });
  assert.match(reply.body, /consent/i);
  reply = await handleIncomingMessage({ phoneE164: phone, text: "Yes", replyId: "AI_CONSENT_YES", messageId: "direct-consent" });
  assert.equal(reply.buttons[0].id, "AI_BOOK_CONFIRM");
  const session = await ConversationSession.findOne({ phoneE164: phone });
  assert.equal(session.state, "BOOKING_CONFIRM");
  return session;
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  await ensureInitialLocations();
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test.beforeEach(async () => {
  successfulMetaFetch();
  metaRequests = [];
  metaSequence = 0;
  await Promise.all([
    Appointment.deleteMany({}), AuditLog.deleteMany({}), BookingRequest.deleteMany({}),
    ConversationSession.deleteMany({}), MessageDeliveryStatus.deleteMany({}), Patient.deleteMany({}),
    PatientConsent.deleteMany({}), ReminderJob.deleteMany({}), RescheduleHistory.deleteMany({}),
    WhatsAppMessage.deleteMany({}), Counter.deleteMany({}), EmergencyAlert.deleteMany({})
  ]);
  await ClinicLocation.updateMany({}, { $set: { blockedDates: [], blockedSlots: [] } });
});

test("webhook verification, signatures, greeting and natural booking work", async () => {
  const verification = await fetch(`${baseUrl}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=whatsapp-verify-token&hub.challenge=321`);
  assert.equal(verification.status, 200);
  assert.equal(await verification.text(), "321");
  const invalid = await postWebhook(incomingWebhook({ id: "wamid.bad", text: "Hi" }), "sha256=invalid");
  assert.equal(invalid.status, 403);

  const greeting = await postWebhook(incomingWebhook({ id: "wamid.hi", text: "Hi" }));
  assert.equal(greeting.status, 200);
  await waitFor(() => WhatsAppMessage.exists({ metaMessageId: "wamid.hi" }));
  await waitFor(() => metaRequests.some((request) => request.payload.type === "text" && /Smart Clinic Assistant/.test(request.payload.text.body)));

  const booking = await postWebhook(incomingWebhook({ id: "wamid.book", text: "I need an appointment on Monday" }));
  assert.equal(booking.status, 200);
  const session = await waitFor(() => ConversationSession.findOne({ phoneE164: "+923001234567", state: "BOOKING_NAME" }));
  assert.ok(session);
  await waitFor(() => metaRequests.some((request) => request.payload.type === "text" && /full name/i.test(request.payload.text.body)));
});

test("secure report upload is offered once after selecting a real slot", async () => {
  const phone = "+923001234567";
  await handleIncomingMessage({ phoneE164: phone, text: "Appointment Monday", messageId: "upload-start" });
  await handleIncomingMessage({ phoneE164: phone, text: "Report Test Patient", messageId: "upload-name" });
  let reply = await handleIncomingMessage({ phoneE164: phone, text: "Shoulder pain", messageId: "upload-reason" });
  const timeId = reply.buttons.find((button) => button.id.startsWith("AI_TIME_")).id;
  reply = await handleIncomingMessage({ phoneE164: phone, text: "Time", replyId: timeId, messageId: "upload-time" });
  assert.match(reply.body, /PDF, JPEG, or PNG/i);
  assert.deepEqual(reply.buttons.map((button) => button.id), ["AI_REPORTS_YES", "AI_REPORTS_NO"]);
});

test("invalid and expired WhatsApp conversation selections fail safely", async () => {
  const phone = "+923001234567";
  let reply = await handleIncomingMessage({ phoneE164: phone, text: "Confirm", replyId: "AI_BOOK_CONFIRM", messageId: "invalid-confirm" });
  assert.match(reply.body, /tell me|appointment|reception/i);
  assert.equal(await Appointment.countDocuments(), 0);

  reply = await handleIncomingMessage({ phoneE164: phone, text: "I need an appointment on 2020-01-01", messageId: "expired-date" });
  assert.match(reply.body, /full name/i);
  assert.equal(await Appointment.countDocuments(), 0);
});

test("emergency language stops automation and creates a visible privacy-safe alert", async () => {
  const phone = "+923001234567";
  const response = await handleIncomingMessage({ phoneE164: phone, text: "He has chest pain and cannot breathe", messageId: "emergency-1" });
  assert.match(response.body, /emergency|urgent/i);
  const session = await ConversationSession.findOne({ phoneE164: phone });
  assert.equal(session.state, "EMERGENCY_STOP");
  const alert = await EmergencyAlert.findOne({ phoneE164: phone });
  assert.equal(alert.status, "open");
  assert.doesNotMatch(alert.alertMessage, /chest pain|cannot breathe/i);
  assert.equal(await Appointment.countDocuments(), 0);
});

test("patient-requested human handoff is visible and pauses AI", async () => {
  const phone = "+923001234567";
  const response = await handleIncomingMessage({ phoneE164: phone, text: "I want to talk to a receptionist", messageId: "handoff-1" });
  assert.match(response.body, /connecting/i);
  const session = await ConversationSession.findOne({ phoneE164: phone });
  assert.equal(session.aiPaused, true);
  assert.equal(session.humanRequired, true);
  assert.match(session.handoffReason, /requested/i);
});

test("appointment ID alone never exposes another patient's visit", async () => {
  const bwp = await ClinicLocation.findOne({ code: "BWP" });
  const dates = await require("../src/services/availabilityService").getAvailableDates("BWP", 60);
  const slots = await require("../src/services/availabilityService").getAvailableSlots("BWP", dates[0].date);
  const appointment = await createAppointment({
    fullName: "Synthetic Owner", phone: "+923001234567", reason: "Follow-up", date: dates[0].date,
    time: slots.find((slot) => slot.available).time, locationId: bwp.code, consentGiven: true
  }, { source: "whatsapp", idempotencyKey: "privacy-owner", skipNotification: true });
  const response = await handleIncomingMessage({
    phoneE164: "+923009999999", text: `Status of ${appointment.appointmentId}`, messageId: "privacy-attacker"
  });
  assert.match(response.body, /couldn.t verify/i);
  assert.doesNotMatch(response.body, new RegExp(appointment.date));
  assert.doesNotMatch(response.body, new RegExp(appointment.time));
});

test("full WhatsApp booking uses the shared engine and a duplicated final webhook creates exactly one appointment", async () => {
  await reachBookingReview();
  const finalEvent = incomingWebhook({ id: "wamid.confirm.once", replyId: "AI_BOOK_CONFIRM", replyTitle: "Confirm Appointment" });
  assert.equal((await postWebhook(finalEvent)).status, 200);
  const appointment = await waitFor(() => Appointment.findOne({
    phoneE164: "+923001234567",
    "patientProvidedVisitSummary.patientName": "WhatsApp Test Patient"
  }));
  assert.ok(appointment.appointmentId.startsWith("DS-"));
  assert.ok(appointment.activeSlotKey);
  assert.equal(appointment.source, "whatsapp");
  assert.equal(appointment.patientProvidedVisitSummary.patientName, "WhatsApp Test Patient");
  assert.ok(appointment.patientProvidedVisitSummary.approvedAt);
  assert.match(appointment.patientProvidedVisitSummary.disclaimer, /not an AI diagnosis/i);
  assert.equal((await PatientConsent.findById(appointment.consent)).consentGiven, true);
  await waitFor(() => WhatsAppMessage.exists({ templateName: "dr_sohaib_appointment_confirmation_v1", status: "queued" }));

  assert.equal((await postWebhook(finalEvent)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await Appointment.countDocuments(), 1);
  assert.equal(await WhatsAppMessage.countDocuments({ metaMessageId: "wamid.confirm.once", direction: "incoming" }), 1);
  assert.equal(await WhatsAppMessage.countDocuments({ templateName: "dr_sohaib_appointment_confirmation_v1" }), 1);
});

test("WhatsApp cancellation and rescheduling use secure phone ownership and configured templates", async () => {
  const phone = "+923001234567";
  await reachBookingReview(phone);
  await handleIncomingMessage({ phoneE164: phone, text: "Confirm", replyId: "AI_BOOK_CONFIRM", messageId: "direct-confirm" });
  let appointment = await Appointment.findOne({ phoneE164: phone });
  let reply = await handleIncomingMessage({ phoneE164: phone, text: `Cancel appointment ${appointment.appointmentId}`, messageId: "cancel-1" });
  assert.equal(reply.buttons[0].id, "AI_CANCEL_CONFIRM");
  reply = await handleIncomingMessage({ phoneE164: phone, text: "Confirm", replyId: "AI_CANCEL_CONFIRM", messageId: "cancel-2" });
  assert.match(reply.body, /cancelled/i);
  appointment = await Appointment.findById(appointment._id);
  assert.equal(appointment.status, "cancelled");
  assert.ok(await WhatsAppMessage.exists({ templateName: "dr_sohaib_cancellation_confirmation_v1" }));

  const bwp = await ClinicLocation.findOne({ code: "BWP" });
  const dates = await require("../src/services/availabilityService").getAvailableDates("BWP", 60);
  const slots = await require("../src/services/availabilityService").getAvailableSlots("BWP", dates[0].date);
  appointment = await createAppointment({
    fullName: "WhatsApp Test Patient", phone, reason: "General", date: dates[0].date,
    time: slots.find((slot) => slot.available).time, locationId: bwp.code, consentGiven: true
  }, { source: "whatsapp", idempotencyKey: "second-booking", skipNotification: true });
  const targetDate = dates.find((item) => item.date !== appointment.date).date;
  reply = await handleIncomingMessage({ phoneE164: phone, text: `Reschedule ${appointment.appointmentId} to ${targetDate}`, messageId: "reschedule-1" });
  assert.ok(reply.buttons, JSON.stringify(reply));
  assert.ok(reply.buttons.some((button) => button.id.startsWith("AI_RESCHEDULE_TIME_")));
  const newTimeId = reply.buttons.find((button) => button.id.startsWith("AI_RESCHEDULE_TIME_")).id;
  reply = await handleIncomingMessage({ phoneE164: phone, text: "New time", replyId: newTimeId, messageId: "reschedule-2" });
  assert.equal(reply.buttons[0].id, "AI_RESCHEDULE_CONFIRM");
  reply = await handleIncomingMessage({ phoneE164: phone, text: "Confirm", replyId: "AI_RESCHEDULE_CONFIRM", messageId: "reschedule-3" });
  assert.match(reply.body, /now scheduled/i);
  appointment = await Appointment.findById(appointment._id);
  assert.equal(appointment.status, "rescheduled");
  assert.equal(appointment.date, targetDate);
  assert.ok(await WhatsAppMessage.exists({ templateName: "dr_sohaib_reschedule_confirmation_v1" }));
});

test("staff messages call Meta, remain queued, and delivery/read events advance the same record idempotently", async () => {
  await ConversationSession.create({
    phoneE164: "+923001234567", state: "STAFF_HANDOVER",
    serviceWindowExpiresAt: new Date(Date.now() + 60 * 60 * 1000)
  });
  const result = await sendStaffMessage("+923001234567", "Authorized clinic reply", { senderStaff: new mongoose.Types.ObjectId() });
  assert.equal(result.status, "queued");
  assert.equal(metaRequests.filter((request) => request.payload.type === "text").length, 1);
  let stored = await WhatsAppMessage.findById(result.message._id);
  assert.equal(stored.status, "queued");
  assert.ok(stored.metaMessageId);

  await updateDeliveryStatus({ id: stored.metaMessageId, recipient_id: "923001234567", status: "sent", timestamp: "1800000000" });
  await updateDeliveryStatus({ id: stored.metaMessageId, recipient_id: "923001234567", status: "delivered", timestamp: "1800000001" });
  await updateDeliveryStatus({ id: stored.metaMessageId, recipient_id: "923001234567", status: "read", timestamp: "1800000002" });
  await updateDeliveryStatus({ id: stored.metaMessageId, recipient_id: "923001234567", status: "read", timestamp: "1800000002" });
  stored = await WhatsAppMessage.findById(stored._id);
  assert.equal(stored.status, "read");
  assert.equal(await MessageDeliveryStatus.countDocuments({ metaMessageId: stored.metaMessageId }), 3);

  const closed = await ConversationSession.create({ phoneE164: "+923009999999", serviceWindowExpiresAt: new Date(Date.now() - 1000) });
  const blocked = await sendStaffMessage(closed.phoneE164, "Outside service window", { senderStaff: new mongoose.Types.ObjectId() });
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.failureCode, "SERVICE_WINDOW_CLOSED");
});

test("Meta authentication and validation failures are stored safely as failed", async () => {
  setMetaFetchForTests(async () => new Response(JSON.stringify({ error: { message: "Access token expired", code: 190 } }), {
    status: 401, headers: { "content-type": "application/json" }
  }));
  const result = await sendText("+923001234567", "Test failure");
  assert.equal(result.status, "failed");
  const stored = await WhatsAppMessage.findById(result.message._id);
  assert.equal(stored.status, "failed");
  assert.equal(stored.failureCode, "190");
  assert.match(stored.failureReason, /expired/i);
  assert.equal(JSON.stringify(stored.toObject()).includes(process.env.WHATSAPP_ACCESS_TOKEN), false);
});
