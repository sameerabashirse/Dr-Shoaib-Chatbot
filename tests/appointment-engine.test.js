const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { DateTime } = require("luxon");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.CORS_ORIGINS = "https://clinic.example";
process.env.FRONTEND_URL = "https://clinic.example";

const { createApp } = require("../src/app");
const {
  Appointment, Patient, PatientConsent, BookingRequest, Counter, RescheduleHistory, ReminderJob,
  AuditLog, ClinicLocation
} = require("../src/models");
const { ensureInitialLocations } = require("../src/services/locationService");
const {
  createAppointment, cancelAppointment, rescheduleAppointment, recalculateQueueTokens
} = require("../src/services/appointmentService");
const {
  getAvailableSlots, blockDate, blockSlot
} = require("../src/services/availabilityService");
const { defaultWeeklyHours, validateSlotAgainstSchedule } = require("../src/utils/time");
const { OCCUPYING_APPOINTMENT_STATUSES, activeSlotKey } = require("../src/domain/appointmentRules");
const { auditActiveSlotData } = require("../src/services/appointmentMigrationService");

let mongod;
let server;
let baseUrl;
let bwp;
let alt;

function futureOpenDate(offsetWeeks = 0, weekday = 1) {
  let date = DateTime.now().setZone("Asia/Karachi").plus({ days: 2, weeks: offsetWeeks }).startOf("day");
  while (date.weekday !== weekday) date = date.plus({ days: 1 });
  return date.toISODate();
}

function booking(overrides = {}) {
  return {
    fullName: "Appointment Engine Patient",
    phone: "03000000001",
    reason: "General consultation",
    date: futureOpenDate(),
    time: "16:30",
    locationId: "BWP",
    consentGiven: true,
    consentTextVersion: "appointment-consent-v1",
    ...overrides
  };
}

async function httpBooking(body, idempotencyKey) {
  const response = await fetch(`${baseUrl}/api/appointments`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
    body: JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  await ensureInitialLocations();
  bwp = await ClinicLocation.findOne({ code: "BWP" });
  alt = await ClinicLocation.create({
    clinicName: "Test Active Clinic", city: "Test City", code: "TST", fullAddress: "Test address",
    status: "Active", isActive: true, bookingEnabled: true, timezone: "Asia/Karachi",
    weeklyHours: defaultWeeklyHours(), slotDurationMinutes: 15
  });
  await Appointment.createIndexes();
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
  await Promise.all([
    Appointment.deleteMany({}), Patient.deleteMany({}), PatientConsent.deleteMany({}), BookingRequest.deleteMany({}),
    Counter.deleteMany({}), RescheduleHistory.deleteMany({}), ReminderJob.deleteMany({}), AuditLog.deleteMany({})
  ]);
  await ClinicLocation.updateMany({}, { $set: { blockedDates: [], blockedSlots: [] } });
});

test("two simultaneous HTTP bookings yield one appointment and one clean 409", async () => {
  const input = booking();
  const [first, second] = await Promise.all([
    httpBooking(input, "simultaneous-a"),
    httpBooking({ ...input, fullName: "Second Patient", phone: "03000000002" }, "simultaneous-b")
  ]);
  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  const loser = first.status === 409 ? first : second;
  assert.equal(loser.data.error.message, "Slot no longer available");
  assert.equal(await Appointment.countDocuments({ status: { $in: OCCUPYING_APPOINTMENT_STATUSES } }), 1);
});

test("fifty concurrent service bookings for one slot create exactly one active appointment", async () => {
  const outcomes = await Promise.allSettled(Array.from({ length: 50 }, (_, index) => createAppointment(
    booking({ fullName: `Patient ${index}`, phone: `03000${String(index).padStart(6, "0")}` }),
    { source: "website", idempotencyKey: `fifty-${index}` }
  )));
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((result) => result.status === "rejected" && result.reason.statusCode === 409).length, 49);
  assert.equal(await Appointment.countDocuments({ activeSlotKey: { $exists: true } }), 1);
});

test("different slots book concurrently and appointment IDs remain globally unique", async () => {
  const times = ["16:30", "16:45", "17:00", "17:15"];
  const appointments = await Promise.all(times.map((time, index) => createAppointment(
    booking({ time, phone: `0300111111${index}` }),
    { source: "website", idempotencyKey: `different-${index}` }
  )));
  assert.equal(new Set(appointments.map((appointment) => appointment.appointmentId)).size, times.length);
  assert.equal(await Appointment.countDocuments({ activeSlotKey: { $exists: true } }), times.length);
});

test("the same local time can be booked at different active locations", async () => {
  const [one, two] = await Promise.all([
    createAppointment(booking(), { source: "website", idempotencyKey: "clinic-one" }),
    createAppointment(booking({ phone: "03000000002", locationId: alt.code }), { source: "website", idempotencyKey: "clinic-two" })
  ]);
  assert.notEqual(one.activeSlotKey, two.activeSlotKey);
});

test("confirmed, scheduled and rescheduled appointments occupy slots while completed and cancelled release them", async () => {
  const date = futureOpenDate();
  const confirmed = await createAppointment(booking({ date, time: "16:30" }), { source: "website", idempotencyKey: "confirmed" });
  const scheduled = await createAppointment(booking({ date, time: "16:45", phone: "03000000002" }), { source: "website", idempotencyKey: "scheduled" });
  const rescheduled = await createAppointment(booking({ date, time: "17:00", phone: "03000000003" }), { source: "website", idempotencyKey: "rescheduled" });
  await Appointment.updateOne({ _id: scheduled._id }, { $set: { status: "scheduled" } });
  await Appointment.updateOne({ _id: rescheduled._id }, { $set: { status: "rescheduled" } });
  let slots = await getAvailableSlots("BWP", date);
  for (const time of ["16:30", "16:45", "17:00"]) {
    const slot = slots.find((entry) => entry.time === time);
    assert.deepEqual({ available: slot.available, booked: slot.booked }, { available: false, booked: true });
  }
  await Appointment.updateOne({ _id: confirmed._id }, { $set: { status: "completed" }, $unset: { activeSlotKey: "" } });
  await cancelAppointment({ appointmentId: scheduled.appointmentId, phone: scheduled.phoneE164 });
  slots = await getAvailableSlots("BWP", date);
  assert.equal(slots.find((entry) => entry.time === "16:30").available, true);
  assert.equal(slots.find((entry) => entry.time === "16:45").available, true);
});

test("cancellation is idempotent, releases the slot and recalculates queue tokens", async () => {
  const date = futureOpenDate();
  const first = await createAppointment(booking({ date, time: "16:30" }), { source: "website", idempotencyKey: "queue-1" });
  const second = await createAppointment(booking({ date, time: "16:45", phone: "03000000002" }), { source: "website", idempotencyKey: "queue-2" });
  const third = await createAppointment(booking({ date, time: "17:00", phone: "03000000003" }), { source: "website", idempotencyKey: "queue-3" });
  const cancelled = await cancelAppointment({ appointmentId: second.appointmentId, phone: second.phoneE164, reason: "Patient request" });
  const repeated = await cancelAppointment({ appointmentId: second.appointmentId, phone: second.phoneE164, reason: "Repeated request" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(repeated.status, "cancelled");
  assert.equal(repeated.cancellationReason, "Patient request");
  assert.equal(repeated.activeSlotKey, undefined);
  const remaining = await Appointment.find({ _id: { $in: [first._id, third._id] } }).sort({ time: 1 });
  assert.deepEqual(remaining.map((appointment) => appointment.tokenNumber), ["001", "002"]);
});

test("rescheduling atomically claims a free slot and records populated-location history", async () => {
  const oldDate = futureOpenDate();
  const newDate = futureOpenDate(1);
  const appointment = await createAppointment(booking({ date: oldDate }), { source: "website", idempotencyKey: "reschedule-free" });
  const populated = await Appointment.findById(appointment._id).populate("location");
  const moved = await rescheduleAppointment({ appointmentId: populated.appointmentId, phone: populated.phoneE164, date: newDate, time: "17:00", locationId: alt.code });
  assert.equal(moved.status, "rescheduled");
  assert.equal(String(moved.location), String(alt._id));
  assert.equal(moved.rescheduleHistory.length, 1);
  assert.equal(String(moved.rescheduleHistory[0].previousLocation), String(bwp._id));
  assert.equal(moved.activeSlotKey, activeSlotKey(alt._id, newDate, "17:00"));
});

test("rescheduling to an occupied slot returns conflict and preserves the original claim", async () => {
  const date = futureOpenDate();
  const original = await createAppointment(booking({ date, time: "16:30" }), { source: "website", idempotencyKey: "move-source" });
  await createAppointment(booking({ date, time: "16:45", phone: "03000000002" }), { source: "website", idempotencyKey: "move-destination" });
  await assert.rejects(
    rescheduleAppointment({ appointmentId: original.appointmentId, phone: original.phoneE164, date, time: "16:45" }),
    (error) => error.statusCode === 409
  );
  const unchanged = await Appointment.findById(original._id);
  assert.equal(unchanged.time, "16:30");
  assert.equal(unchanged.activeSlotKey, activeSlotKey(bwp._id, date, "16:30"));
});

test("blocked dates, blocked slots, closed weekdays and Coming Soon clinics cannot be booked", async () => {
  const monday = futureOpenDate(0, 1);
  const tuesday = DateTime.fromISO(monday).plus({ days: 1 }).toISODate();
  const friday = DateTime.fromISO(monday).plus({ days: 4 }).toISODate();
  await blockDate({ locationId: "BWP", date: monday, reason: "Holiday" });
  await blockSlot({ locationId: "BWP", date: tuesday, time: "16:30", reason: "Doctor unavailable" });
  await assert.rejects(createAppointment(booking({ date: monday }), { source: "website" }), (error) => error.statusCode === 409);
  await assert.rejects(createAppointment(booking({ date: tuesday }), { source: "website" }), (error) => error.statusCode === 409);
  await assert.rejects(createAppointment(booking({ date: friday }), { source: "website" }), (error) => error.statusCode === 400);
  await assert.rejects(createAppointment(booking({ date: monday, locationId: "BWN" }), { source: "website" }), (error) => error.statusCode === 400);
  const comingSoon = await ClinicLocation.create({
    clinicName: "Coming Soon Test", city: "Future City", code: "CST", fullAddress: "TBA",
    status: "Coming Soon", isActive: true, bookingEnabled: true, timezone: "Asia/Karachi",
    weeklyHours: defaultWeeklyHours(), slotDurationMinutes: 15
  });
  await assert.rejects(createAppointment(booking({ date: monday, locationId: comingSoon.code }), { source: "website" }), (error) => error.statusCode === 400);
});

test("past validation and timezone boundaries use the clinic timezone", async () => {
  const settings = { timezone: "Asia/Karachi", weeklyHours: defaultWeeklyHours(), slotDurationMinutes: 15 };
  const monday = futureOpenDate(0, 1);
  const before = DateTime.fromISO(`${monday}T16:29`, { zone: "Asia/Karachi" });
  const after = DateTime.fromISO(`${monday}T16:31`, { zone: "Asia/Karachi" });
  assert.equal(validateSlotAgainstSchedule({ settings, date: monday, time: "16:30", now: before }).ok, true);
  assert.equal(validateSlotAgainstSchedule({ settings, date: monday, time: "16:30", now: after }).ok, false);
  await assert.rejects(createAppointment(booking({ date: "2020-01-06" }), { source: "website" }), (error) => error.statusCode === 400);
  await assert.rejects(createAppointment(booking({ date: monday, time: "16:31" }), { source: "website" }), (error) => error.statusCode === 400);
});

test("website and WhatsApp retries are idempotent and different payload reuse is rejected", async () => {
  const input = booking();
  const [first, repeated] = await Promise.all([
    httpBooking(input, "web-retry"),
    httpBooking(input, "web-retry")
  ]);
  assert.deepEqual([first.status, repeated.status].sort(), [201, 201]);
  assert.equal(first.data.appointment.appointmentId, repeated.data.appointment.appointmentId);
  const whatsappOne = await createAppointment(booking({ time: "16:45", phone: "03000000002" }), { source: "whatsapp", idempotencyKey: "wamid.duplicate" });
  const whatsappTwo = await createAppointment(booking({ time: "16:45", phone: "03000000002" }), { source: "whatsapp", idempotencyKey: "wamid.duplicate" });
  assert.equal(whatsappOne.appointmentId, whatsappTwo.appointmentId);
  await assert.rejects(
    createAppointment(booking({ time: "17:00", phone: "03000000003" }), { source: "whatsapp", idempotencyKey: "wamid.duplicate" }),
    (error) => error.statusCode === 409
  );
  assert.equal(await Appointment.countDocuments(), 2);
});

test("verified returning contacts retain separate self and family profiles", async () => {
  await createAppointment(booking({
    fullName: "Ahmed Synthetic", patientFor: "self", phone: "03000000991"
  }), { source: "whatsapp", idempotencyKey: "profile-self", skipNotification: true });
  await createAppointment(booking({
    fullName: "Fatima Synthetic", age: 58, patientFor: "family", phone: "03000000991",
    date: futureOpenDate(0, 2)
  }), { source: "whatsapp", idempotencyKey: "profile-family", skipNotification: true });
  const patient = await Patient.findOne({ phoneE164: "+923000000991" });
  assert.equal(patient.fullName, "Ahmed Synthetic");
  assert.equal(patient.knownProfiles.length, 2);
  assert.equal(patient.knownProfiles.find((profile) => profile.relationship === "family").fullName, "Fatima Synthetic");
});

test("all booking sources share blocked-slot rules and the unique indexes exist", async () => {
  const date = futureOpenDate();
  await blockSlot({ locationId: "BWP", date, time: "18:00", reason: "Blocked" });
  for (const source of ["website", "whatsapp", "staff"]) {
    await assert.rejects(
      createAppointment(booking({ date, time: "18:00", phone: `0300${source.length}000000` }), { source, idempotencyKey: `source-${source}` }),
      (error) => error.statusCode === 409
    );
  }
  const indexes = await Appointment.collection.indexes();
  assert.equal(indexes.find((index) => index.name === "uniq_active_appointment_slot")?.unique, true);
  assert.equal(indexes.find((index) => index.name === "uniq_appointment_idempotency")?.unique, true);
  const report = await auditActiveSlotData();
  assert.equal(report.duplicateSlotCount, 0);
  assert.equal(report.invalidRecordCount, 0);
});
