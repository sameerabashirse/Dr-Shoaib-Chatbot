const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { DateTime } = require("luxon");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.CORS_ORIGINS = "https://clinic.example";
process.env.FRONTEND_URL = "https://clinic.example";
process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.WHATSAPP_TEMPLATE_APPOINTMENT_REMINDER = "appointment_reminder_v1";
process.env.WHATSAPP_TEMPLATE_APPOINTMENT_REMINDER_LANGUAGE = "en_US";
process.env.APPOINTMENT_CONSENT_TEXT = "The clinic will use your information for appointment management, reminders, rescheduling, and clinic communications.";
process.env.APPOINTMENT_CONSENT_VERSION = "appointment-consent-v1";

const { config } = require("../src/config/env");
const {
  Appointment, AuditLog, BookingRequest, ClinicLocation, ClinicSettings, Counter,
  EmailNotificationOutbox, Patient, PatientConsent, ReminderJob, RescheduleHistory, WhatsAppMessage
} = require("../src/models");
const { ensureInitialLocations } = require("../src/services/locationService");
const { createAppointment, cancelAppointment, rescheduleAppointment } = require("../src/services/appointmentService");
const {
  processDueReminders, recoverMissingReminderSchedules, retryFailedReminder, scheduleAppointmentReminders
} = require("../src/services/reminderService");
const { setMetaFetchForTests, updateDeliveryStatus } = require("../src/services/whatsappService");
const { getClinicSettings, updateClinicSettings } = require("../src/services/settingsService");
const ownerOutbox = require("../src/services/ownerEmailOutboxService");
const { EmailDeliveryError } = require("../src/services/emailTransport");
const { audit } = require("../src/services/auditService");

let mongod;
let bwp;
let metaCalls;
let metaPayloads;

function futureOpenDate(weekOffset = 2) {
  let value = DateTime.now().setZone("Asia/Karachi").plus({ weeks: weekOffset }).startOf("day");
  while (value.weekday !== 1) value = value.plus({ days: 1 });
  return value.toISODate();
}

function input(overrides = {}) {
  return {
    fullName: "Sprint Six Patient",
    phone: "03001234567",
    reason: "General consultation",
    date: futureOpenDate(),
    time: "16:30",
    locationId: "BWP",
    consentGiven: true,
    consentTextVersion: "appointment-consent-v1",
    ...overrides
  };
}

async function book(overrides = {}, key = `s6-${Math.random()}`) {
  return createAppointment(input(overrides), { source: "website", idempotencyKey: key, skipNotification: true });
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  await ensureInitialLocations();
  bwp = await ClinicLocation.findOne({ code: "BWP" });
  await Promise.all([ReminderJob.createIndexes(), EmailNotificationOutbox.createIndexes()]);
});

test.after(async () => {
  setMetaFetchForTests(global.fetch);
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  metaCalls = 0;
  metaPayloads = [];
  config.emailAppointmentAlert.enabled = false;
  config.whatsapp.templates.arrivalUpdate = "";
  await Promise.all([
    Appointment.deleteMany({}), AuditLog.deleteMany({}), BookingRequest.deleteMany({}), Counter.deleteMany({}),
    EmailNotificationOutbox.deleteMany({}), Patient.deleteMany({}), PatientConsent.deleteMany({}),
    ReminderJob.deleteMany({}), RescheduleHistory.deleteMany({}), WhatsAppMessage.deleteMany({}), ClinicSettings.deleteMany({})
  ]);
  await ClinicSettings.create({ key: "default", remindersEnabled: true, reminderIntervalsMinutes: [60, 30] });
  await ClinicLocation.updateMany({}, { $set: { blockedDates: [], blockedSlots: [] } });
  setMetaFetchForTests(async (url, options) => {
    metaCalls += 1;
    metaPayloads.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ messages: [{ id: `wamid.reminder.${metaCalls}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
});

test("arrival update uses only the administrator-entered clinic delay", async () => {
  config.whatsapp.templates.arrivalUpdate = "arrival_update_v1";
  config.whatsapp.templates.arrivalUpdateLanguage = "en_US";
  await ClinicLocation.updateOne({ _id: bwp._id }, { $set: { currentDelayMinutes: 20, delayUpdatedAt: new Date() } });
  const appointment = await book({}, "arrival-update");
  const arrival = await ReminderJob.findOne({ appointment: appointment._id, type: "arrival_update" });
  assert.ok(arrival);
  arrival.dueAt = new Date(Date.now() - 1000);
  await arrival.save();
  const results = await processDueReminders({ limit: 1 });
  assert.equal(results[0].status, "queued");
  const parameters = metaPayloads[0].template.components[0].parameters.map((parameter) => parameter.text);
  assert.ok(parameters.includes("Dr. Sohaib is approximately 20 minutes behind schedule."));
  assert.ok(parameters.some((value) => /\d{2}:\d{2} [AP]M/.test(value)));
});

test("confirmed appointments create the configured jobs once and do not claim they were sent", async () => {
  const appointment = await book();
  assert.equal(await ReminderJob.countDocuments({ appointment: appointment._id }), 2);
  assert.equal(await ReminderJob.countDocuments({ appointment: appointment._id, message: { $exists: true, $ne: "" } }), 2);
  await scheduleAppointmentReminders(appointment);
  assert.equal(await ReminderJob.countDocuments({ appointment: appointment._id }), 2);
  const saved = await Appointment.findById(appointment._id);
  assert.equal(saved.reminderStatus, "pending");
  assert.equal(await ReminderJob.countDocuments({ sentAt: { $exists: true } }), 0);
});

test("Meta acceptance queues a reminder; only a Meta sent callback marks it sent", async () => {
  const appointment = await book();
  const job = await ReminderJob.findOne({ appointment: appointment._id });
  job.dueAt = new Date(Date.now() - 1000);
  await job.save();
  await processDueReminders({ limit: 1 });
  let saved = await ReminderJob.findById(job._id);
  assert.equal(saved.status, "queued");
  assert.equal(saved.sentAt, undefined);
  await updateDeliveryStatus({ id: saved.metaMessageId, status: "sent", recipient_id: "923001234567", timestamp: String(Math.floor(Date.now() / 1000)) });
  saved = await ReminderJob.findById(job._id);
  assert.equal(saved.status, "sent");
  assert.ok(saved.sentAt instanceof Date);
});

test("cancellation suppresses every pending reminder", async () => {
  const appointment = await book();
  await cancelAppointment({ appointmentId: appointment.appointmentId, phone: appointment.phoneE164 }, { source: "website", skipNotification: true });
  assert.equal(await ReminderJob.countDocuments({ appointment: appointment._id, status: "cancelled" }), 2);
  await ReminderJob.updateMany({ appointment: appointment._id }, { $set: { dueAt: new Date(Date.now() - 1000) } });
  await processDueReminders();
  assert.equal(metaCalls, 0);
});

test("a late Meta callback cannot reactivate a cancelled reminder", async () => {
  const appointment = await book();
  const job = await ReminderJob.findOne({ appointment: appointment._id });
  job.status = "queued";
  job.metaMessageId = "wamid.cancelled.late";
  await job.save();
  await cancelAppointment({ appointmentId: appointment.appointmentId, phone: appointment.phoneE164 }, { source: "website", skipNotification: true });
  await updateDeliveryStatus({ id: job.metaMessageId, status: "sent", recipient_id: "923001234567", timestamp: String(Math.floor(Date.now() / 1000)) });
  assert.equal((await ReminderJob.findById(job._id)).status, "cancelled");
  assert.equal((await Appointment.findById(appointment._id)).reminderStatus, "cancelled");
});

test("rescheduling cancels old jobs and creates one new revision", async () => {
  const appointment = await book();
  const moved = await rescheduleAppointment({
    appointmentId: appointment.appointmentId,
    phone: appointment.phoneE164,
    date: futureOpenDate(3),
    time: "16:45"
  }, { source: "website", skipNotification: true });
  assert.equal(moved.rescheduleCount, 1);
  assert.equal(await ReminderJob.countDocuments({ appointment: appointment._id, scheduleRevision: 0, status: "cancelled" }), 2);
  assert.equal(await ReminderJob.countDocuments({ appointment: appointment._id, scheduleRevision: 1, status: "pending" }), 2);
});

test("failed reminders retry safely without creating another job", async () => {
  setMetaFetchForTests(async () => new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503, headers: { "content-type": "application/json" } }));
  const appointment = await book();
  const job = await ReminderJob.findOne({ appointment: appointment._id });
  job.dueAt = new Date(Date.now() - 1000);
  await job.save();
  await processDueReminders({ limit: 1 });
  await processDueReminders({ limit: 1 });
  await processDueReminders({ limit: 1 });
  assert.equal((await ReminderJob.findById(job._id)).status, "failed");
  const retried = await retryFailedReminder(job._id, {});
  assert.equal(retried.status, "pending");
  assert.equal(await ReminderJob.countDocuments({ appointment: appointment._id }), 2);
  assert.ok(await AuditLog.findOne({ action: "reminder.retry_requested" }));
});

test("follow-up jobs retain required message data and are processed", async () => {
  const patient = await Patient.create({ fullName: "Follow Up Patient", phoneE164: "+923001112222" });
  const job = await ReminderJob.create({
    dedupeKey: "follow-up:test",
    patient: patient._id,
    phoneE164: patient.phoneE164,
    type: "follow_up_reminder",
    dueAt: new Date(Date.now() - 1000),
    message: "Please contact the clinic for your follow-up.",
    status: "pending"
  });
  await processDueReminders({ limit: 1 });
  assert.equal((await ReminderJob.findById(job._id)).status, "queued");
  assert.equal(metaPayloads[0].type, "text");
  assert.equal(metaPayloads[0].text.body, job.message);
});

test("past reminder times create no job and are labelled not scheduled", async () => {
  await updateClinicSettings({ remindersEnabled: true, reminderIntervalsMinutes: [525600] }, null);
  const appointment = await book({}, "past-reminder-time");
  assert.equal(await ReminderJob.countDocuments({ appointment: appointment._id }), 0);
  assert.equal((await Appointment.findById(appointment._id)).reminderStatus, "not_scheduled");
});

test("the scheduler recovers a missing reminder schedule without duplicates", async () => {
  const appointment = await book({}, "recovery");
  await ReminderJob.deleteMany({ appointment: appointment._id });
  await Appointment.updateOne({ _id: appointment._id }, { $set: { reminderStatus: "failed" } });
  assert.equal(await recoverMissingReminderSchedules(), 1);
  assert.equal(await ReminderJob.countDocuments({ appointment: appointment._id }), 2);
  assert.equal(await recoverMissingReminderSchedules(), 0);
});

test("reminder settings persist enabled state and unique intervals", async () => {
  await updateClinicSettings({ remindersEnabled: false, reminderIntervalsMinutes: [120, 30] }, null);
  const raw = await ClinicSettings.findOne({ key: "default" });
  assert.equal(raw.remindersEnabled, false);
  assert.deepEqual(raw.reminderIntervalsMinutes, [120, 30]);
  const reloaded = await getClinicSettings();
  assert.equal(reloaded.remindersEnabled, false);
  const appointment = await book({}, "reminders-disabled");
  assert.equal(await ReminderJob.countDocuments({ appointment: appointment._id }), 0);
  assert.equal((await Appointment.findById(appointment._id)).reminderStatus, "not_scheduled");
});

test("false consent prevents booking and is stored exactly as declined", async () => {
  await assert.rejects(() => book({ consentGiven: false }, "declined"), /Active patient consent/);
  assert.equal(await Appointment.countDocuments(), 0);
  assert.equal(await PatientConsent.countDocuments({ consentGiven: true }), 0);
  const declined = await PatientConsent.findOne({ consentGiven: false });
  assert.equal(declined.consentGiven, false);
  assert.equal(declined.consentTextVersion, "appointment-consent-v1");
});

test("accepted consent stores exact status, source, timestamp, text and version", async () => {
  const appointment = await book();
  const consent = await PatientConsent.findById(appointment.consent);
  assert.equal(consent.consentGiven, true);
  assert.equal(consent.channel, "website");
  assert.equal(consent.consentText, process.env.APPOINTMENT_CONSENT_TEXT);
  assert.equal(consent.consentTextVersion, "appointment-consent-v1");
  assert.ok(consent.consentedAt instanceof Date);
});

test("one owner email is queued after booking and an email failure cannot cancel it", async () => {
  Object.assign(config.emailAppointmentAlert, {
    enabled: true,
    to: "owner@clinic.example",
    fromAddress: "notifications@clinic.example",
    smtp: { host: "smtp.clinic.example", port: 587, secure: false, user: "smtp-user", password: "smtp-password" }
  });
  const originalKick = ownerOutbox.kickOwnerEmailWorker;
  ownerOutbox.kickOwnerEmailWorker = () => undefined;
  try {
    const appointment = await book({}, "owner-email");
    await createAppointment(input(), { source: "website", idempotencyKey: "owner-email", skipNotification: true });
    assert.equal(await EmailNotificationOutbox.countDocuments({ appointmentId: appointment._id }), 1);
    await ownerOutbox.processOwnerEmailJobs({
      limit: 1,
      send: async () => { throw new EmailDeliveryError("EMAIL_TEMPORARY_FAILURE", true); }
    });
    assert.notEqual((await Appointment.findById(appointment._id)).status, "cancelled");
    assert.equal((await EmailNotificationOutbox.findOne({ appointmentId: appointment._id })).status, "queued");
    await EmailNotificationOutbox.updateOne({ appointmentId: appointment._id }, { $set: { nextRetryAt: new Date(0) } });
    let successfulDeliveries = 0;
    const send = async () => ({ messageId: `synthetic-email-${++successfulDeliveries}` });
    await ownerOutbox.processOwnerEmailJobs({ limit: 1, send });
    await ownerOutbox.processOwnerEmailJobs({ limit: 1, send });
    assert.equal(successfulDeliveries, 1);
    assert.equal((await EmailNotificationOutbox.findOne({ appointmentId: appointment._id })).status, "sent");
  } finally {
    ownerOutbox.kickOwnerEmailWorker = originalKick;
  }
});

test("audit actor, target, request context, and safe before/after fields persist", async () => {
  const patient = await Patient.create({ fullName: "Audit Patient", phoneE164: "+923009999999" });
  const req = { requestId: "request-12345678", ip: "203.0.113.10", get: (name) => name === "user-agent" ? "Sprint6 Mobile Browser" : "" };
  await audit({
    actorType: "patient",
    actorPatient: patient._id,
    actorPhone: patient.phoneE164,
    action: "patient.updated",
    entityType: "patient",
    entityId: String(patient._id),
    before: { fullName: "Old", accessToken: "must-not-save" },
    after: { fullName: "Audit Patient", password: "must-not-save" },
    req
  });
  const record = await AuditLog.findOne({ action: "patient.updated" }).lean();
  assert.equal(record.actorId, String(patient._id));
  assert.equal(record.actorPhone, patient.phoneE164);
  assert.equal(record.targetType, "patient");
  assert.equal(record.targetId, String(patient._id));
  assert.equal(record.ip, "203.0.113.10");
  assert.equal(record.userAgent, "Sprint6 Mobile Browser");
  assert.equal(record.beforeSummary.accessToken, undefined);
  assert.equal(record.afterSummary.password, undefined);
});
