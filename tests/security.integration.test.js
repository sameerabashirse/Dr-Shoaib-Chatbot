const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.CORS_ORIGINS = "https://clinic.example";
process.env.FRONTEND_URL = "https://clinic.example";
process.env.META_APP_SECRET = "integration-meta-secret";
process.env.WHATSAPP_VERIFY_TOKEN = "integration-verify-token";

const { createApp } = require("../src/app");
const { createStaffUser } = require("../src/services/authService");
const { ensureInitialLocations } = require("../src/services/locationService");
const { AuditLog, MessageDeliveryStatus } = require("../src/models");
const { config } = require("../src/config/env");
const { setMetaFetchForTests } = require("../src/services/whatsappService");
const { setMedicalFileStorageForTests } = require("../src/services/medicalFileStorage");
const { GROUPS, expandEndpointPolicies, normalizePath } = require("../src/security/endpointPolicy");

let mongod;
let server;
let baseUrl;
const tokens = {};
let appointment;

async function request(path, { method = "GET", token, body, origin, rawBody, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (origin) requestHeaders.origin = origin;
  let payload;
  if (rawBody !== undefined) {
    payload = rawBody;
    requestHeaders["content-type"] ||= "application/json";
  } else if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    requestHeaders["content-type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers: requestHeaders, body: payload });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { response, data, text };
}

async function login(email, password) {
  const result = await request("/api/auth/login", { method: "POST", body: { email, password } });
  assert.equal(result.response.status, 200);
  return result.data.accessToken;
}

test.before(async () => {
  const privateFiles = new Map();
  setMedicalFileStorageForTests({
    async putObject({ key, body }) { privateFiles.set(key, Buffer.from(body)); },
    async getObject({ key }) { return require("node:stream").Readable.from(privateFiles.get(key)); },
    async deleteObject({ key }) { privateFiles.delete(key); }
  });
  config.whatsapp.accessToken = "test-access-token";
  config.whatsapp.phoneNumberId = "123456789";
  let metaSequence = 0;
  setMetaFetchForTests(async () => new Response(JSON.stringify({ messages: [{ id: `wamid.security.${++metaSequence}` }] }), {
    status: 200, headers: { "content-type": "application/json" }
  }));
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  await Promise.all([
    createStaffUser({ name: "Admin", email: "admin@test.local", password: "Admin@Test123", role: "super_admin" }),
    createStaffUser({ name: "Doctor", email: "doctor@test.local", password: "Doctor@Test123", role: "doctor" }),
    createStaffUser({ name: "Reception", email: "reception@test.local", password: "Reception@Test123", role: "receptionist" }),
    createStaffUser({ name: "Staff", email: "staff@test.local", password: "Staff@Test123", role: "clinic_staff" })
  ]);
  await ensureInitialLocations();
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tokens.super_admin = await login("admin@test.local", "Admin@Test123");
  tokens.doctor = await login("doctor@test.local", "Doctor@Test123");
  tokens.receptionist = await login("reception@test.local", "Reception@Test123");
  tokens.clinic_staff = await login("staff@test.local", "Staff@Test123");
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test("every private endpoint rejects missing authentication without leaking data", async () => {
  const privateRequests = [
    ["GET", "/api/auth/me"], ["GET", "/api/auth/users"], ["POST", "/api/auth/users", {}], ["PATCH", "/api/auth/users/507f1f77bcf86cd799439011", {}],
    ["GET", "/api/appointments"], ["POST", "/api/appointments/manual", {}], ["PATCH", "/api/appointments/507f1f77bcf86cd799439011/reschedule", {}], ["GET", "/api/appointments/507f1f77bcf86cd799439011"], ["PATCH", "/api/appointments/507f1f77bcf86cd799439011/status", {}],
    ["POST", "/api/availability/block-date", {}], ["POST", "/api/availability/unblock-date", {}], ["POST", "/api/availability/block-slot", {}], ["POST", "/api/availability/unblock-slot", {}],
    ["GET", "/api/reports"], ["GET", "/api/reports/appointment/DS-TEST"], ["GET", "/api/reports/507f1f77bcf86cd799439011"], ["GET", "/api/reports/507f1f77bcf86cd799439011/download"], ["DELETE", "/api/reports/507f1f77bcf86cd799439011"], ["PATCH", "/api/reports/507f1f77bcf86cd799439011/status", {}],
    ["GET", "/api/online-consultations"], ["GET", "/api/online-consultations/507f1f77bcf86cd799439011"], ["PATCH", "/api/online-consultations/507f1f77bcf86cd799439011/status", {}],
    ["GET", "/api/conversations"], ["GET", "/api/conversations/507f1f77bcf86cd799439011"], ["POST", "/api/conversations/507f1f77bcf86cd799439011/messages", {}], ["POST", "/api/conversations/507f1f77bcf86cd799439011/takeover", {}], ["POST", "/api/conversations/507f1f77bcf86cd799439011/reactivate-ai", {}],
    ["GET", "/api/dashboard/summary"], ["GET", "/api/dashboard/recent-appointments"], ["GET", "/api/dashboard/recent-reports"], ["GET", "/api/dashboard/recent-consultations"], ["GET", "/api/dashboard/emergency-alerts"],
    ["PUT", "/api/doctors/dr-sohaib", {}], ["GET", "/api/settings/clinic"], ["PUT", "/api/settings/clinic", {}], ["GET", "/api/settings/doctor-profile"], ["PUT", "/api/settings/doctor-profile", {}], ["GET", "/api/settings/audit-logs"],
    ["GET", "/api/clinic-locations"], ["GET", "/api/clinics"], ["POST", "/api/clinic-locations", {}], ["PUT", "/api/clinic-locations/507f1f77bcf86cd799439011", {}],
    ["GET", "/api/patients"], ["GET", "/api/patients/507f1f77bcf86cd799439011"], ["POST", "/api/patients/507f1f77bcf86cd799439011/notes", {}],
    ["GET", "/api/reminders"], ["POST", "/api/reminders/follow-up", {}], ["PATCH", "/api/reminders/507f1f77bcf86cd799439011/status", {}],
    ["GET", "/api/emergencies"], ["PATCH", "/api/emergencies/507f1f77bcf86cd799439011/resolve", {}],
    ["POST", "/api/whatsapp/simulate-message", {}], ["GET", "/api/whatsapp/conversations"], ["GET", "/api/whatsapp/conversations/%2B923001234567/messages"], ["POST", "/api/whatsapp/conversations/%2B923001234567/takeover", {}], ["POST", "/api/whatsapp/conversations/%2B923001234567/reactivate-ai", {}], ["POST", "/api/whatsapp/conversations/%2B923001234567/send", {}]
  ];

  for (const [method, path, body] of privateRequests) {
    const result = await request(path, { method, body });
    assert.equal(result.response.status, 401, `${method} ${path}`);
    assert.equal(result.data?.error?.code, "UNAUTHORIZED", `${method} ${path}`);
    assert.equal(JSON.stringify(result.data).includes("phoneE164"), false, `${method} ${path}`);
  }
});

test("endpoint policy inventory covers every mounted Express route without stale entries", () => {
  const discovered = [];
  for (const group of GROUPS) {
    const router = require(`../src/routes/${group.module}`);
    for (const mount of group.mounts) {
      for (const layer of router.stack) {
        if (!layer.route) continue;
        for (const method of Object.keys(layer.route.methods)) {
          discovered.push(`${method.toUpperCase()} ${normalizePath(`${mount}${layer.route.path}`)}`);
        }
      }
    }
  }
  const documented = expandEndpointPolicies().map((policy) => `${policy.method} ${policy.path}`);
  assert.deepEqual([...new Set(documented)].sort(), [...new Set(discovered)].sort());
  assert.equal(documented.length, discovered.length, "Duplicate endpoint policies are not allowed");
});

test("every staff endpoint enforces authentication and the complete four-role matrix", async () => {
  const objectId = "507f1f77bcf86cd799439011";
  const concretePath = (value) => value
    .replaceAll(":locationId", "BWP")
    .replaceAll(":appointmentId", "DS-TEST")
    .replaceAll(":phone", encodeURIComponent("+923001234567"))
    .replaceAll(":id", objectId);
  const policies = expandEndpointPolicies().filter((policy) => ["staff_authenticated", "staff_permission"].includes(policy.access));
  const roleIps = { super_admin: "198.51.100.10", doctor: "198.51.100.11", receptionist: "198.51.100.12", clinic_staff: "198.51.100.13" };

  for (const policy of policies) {
    const path = concretePath(policy.path);
    const anonymous = await request(path, {
      method: policy.method,
      body: ["POST", "PUT", "PATCH"].includes(policy.method) ? {} : undefined,
      headers: { "x-forwarded-for": "198.51.100.9" }
    });
    assert.equal(anonymous.response.status, 401, `${policy.method} ${policy.path} must require authentication`);

    for (const role of Object.keys(tokens)) {
      const result = await request(path, {
        method: policy.method,
        token: tokens[role],
        body: ["POST", "PUT", "PATCH"].includes(policy.method) ? {} : undefined,
        headers: { "x-forwarded-for": roleIps[role] }
      });
      if (policy.roles.includes(role)) {
        assert.notEqual(result.response.status, 401, `${role} unexpectedly unauthenticated for ${policy.method} ${policy.path}`);
        assert.notEqual(result.response.status, 403, `${role} unexpectedly forbidden for ${policy.method} ${policy.path}`);
      } else {
        assert.equal(result.response.status, 403, `${role} must be forbidden for ${policy.method} ${policy.path}`);
        assert.equal(result.data?.error?.code, "FORBIDDEN", `${policy.method} ${policy.path}`);
      }
    }
  }
});

test("public booking and verified self-service work while ID-only access is denied", async () => {
  const dates = await request("/api/availability/dates?locationId=BWP&days=30");
  assert.equal(dates.response.status, 200);
  assert.ok(dates.data.dates.length > 0);
  const date = dates.data.dates[0].date;
  const slots = await request(`/api/availability/slots?locationId=BWP&date=${date}`);
  const time = slots.data.slots.find((slot) => slot.available).time;

  const booked = await request("/api/appointments", {
    method: "POST",
    body: { fullName: "Security Test Patient", phone: "03001234567", reason: "General consultation", date, time, locationId: "BWP", consentGiven: true, consentTextVersion: "appointment-consent-v1" }
  });
  assert.equal(booked.response.status, 201);
  appointment = booked.data.appointment;
  assert.ok(appointment.appointmentId);
  assert.equal("phoneE164" in appointment, false);

  const noConsent = await request("/api/appointments", {
    method: "POST",
    body: { fullName: "No Consent", phone: "03008887777", reason: "General consultation", date, time, locationId: "BWP", consentGiven: false, consentTextVersion: "appointment-consent-v1" }
  });
  assert.equal(noConsent.response.status, 400);

  const idOnlyGet = await request(`/api/appointments/${appointment.appointmentId}`);
  assert.equal(idOnlyGet.response.status, 401);
  const idOnlyConfirm = await request(`/api/appointments/${appointment.appointmentId}/confirm`, { method: "POST", body: {} });
  assert.equal(idOnlyConfirm.response.status, 400);

  const wrongLookup = await request("/api/appointments/lookup", { method: "POST", body: { appointmentId: appointment.appointmentId, phone: "03007654321" } });
  const wrongCancel = await request("/api/appointments/cancel", { method: "POST", body: { appointmentId: appointment.appointmentId, phone: "03007654321" } });
  assert.equal(wrongLookup.response.status, 404);
  assert.equal(wrongCancel.response.status, 404);
  assert.equal(wrongLookup.data.error.message, wrongCancel.data.error.message);

  const lookup = await request("/api/appointments/lookup", { method: "POST", body: { appointmentId: appointment.appointmentId, phone: "03001234567" } });
  assert.equal(lookup.response.status, 200);
  assert.equal("phoneE164" in lookup.data.appointment, false);

  const nextDate = dates.data.dates.find((entry) => entry.date !== date)?.date;
  assert.ok(nextDate);
  const nextSlots = await request(`/api/availability/slots?locationId=BWP&date=${nextDate}`);
  const nextTime = nextSlots.data.slots.find((slot) => slot.available).time;
  const rescheduled = await request("/api/appointments/reschedule", { method: "POST", body: { appointmentId: appointment.appointmentId, phone: "03001234567", date: nextDate, time: nextTime } });
  assert.equal(rescheduled.response.status, 200);

  const confirmed = await request(`/api/appointments/${appointment.appointmentId}/confirm`, { method: "POST", body: { phone: "03001234567" } });
  assert.equal(confirmed.response.status, 200);

  const cancelled = await request("/api/appointments/cancel", { method: "POST", body: { appointmentId: appointment.appointmentId, phone: "03001234567" } });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.data.appointment.status, "cancelled");
});

test("role permissions enforce least privilege and authorized role flows", async () => {
  const forbiddenChecks = [
    [tokens.doctor, "GET", "/api/auth/users"],
    [tokens.doctor, "PUT", "/api/settings/clinic", {}],
    [tokens.doctor, "POST", "/api/availability/block-date", {}],
    [tokens.receptionist, "PUT", "/api/doctors/dr-sohaib", {}],
    [tokens.receptionist, "PATCH", "/api/reports/507f1f77bcf86cd799439011/status", { status: "Reviewed" }],
    [tokens.clinic_staff, "GET", "/api/reports"],
    [tokens.clinic_staff, "GET", "/api/online-consultations"],
    [tokens.clinic_staff, "GET", "/api/dashboard/recent-reports"],
    [tokens.clinic_staff, "GET", "/api/dashboard/recent-consultations"],
    [tokens.clinic_staff, "POST", "/api/appointments/manual", {}],
    [tokens.clinic_staff, "POST", "/api/reminders/follow-up", {}],
    [tokens.clinic_staff, "PATCH", "/api/emergencies/507f1f77bcf86cd799439011/resolve", {}]
  ];
  for (const [token, method, path, body] of forbiddenChecks) {
    const result = await request(path, { token, method, body });
    assert.equal(result.response.status, 403, `${method} ${path}`);
    assert.equal(result.data.error.code, "FORBIDDEN");
  }

  assert.equal((await request("/api/auth/users", { token: tokens.super_admin })).response.status, 200);
  assert.equal((await request("/api/settings/clinic", { token: tokens.super_admin })).response.status, 200);
  assert.equal((await request("/api/settings/doctor-profile", { token: tokens.super_admin })).response.status, 200);
  assert.equal((await request("/api/patients", { token: tokens.doctor })).response.status, 200);
  assert.equal((await request("/api/reports", { token: tokens.doctor })).response.status, 200);
  assert.equal((await request("/api/appointments", { token: tokens.receptionist })).response.status, 200);
  assert.equal((await request("/api/dashboard/summary", { token: tokens.clinic_staff })).response.status, 200);
  const staffAppointments = await request("/api/appointments", { token: tokens.clinic_staff });
  assert.equal("phoneE164" in staffAppointments.data.appointments[0], false);
  const staffPatients = await request("/api/patients", { token: tokens.clinic_staff });
  assert.equal("notes" in staffPatients.data.patients[0], false);
  assert.equal("phoneE164" in staffPatients.data.patients[0], false);
  assert.ok(staffPatients.data.patients[0].phoneMasked);
});

test("clinic staff cannot set unrestricted appointment statuses", async () => {
  const dates = await request("/api/availability/dates?locationId=BWP&days=30");
  const date = dates.data.dates[0].date;
  const slots = await request(`/api/availability/slots?locationId=BWP&date=${date}`);
  const time = slots.data.slots.find((slot) => slot.available).time;
  const created = await request("/api/appointments", {
    method: "POST",
    headers: { "idempotency-key": "security-status-transition" },
    body: { fullName: "Status Test Patient", phone: "03009990000", reason: "Status test", date, time, locationId: "BWP", consentGiven: true, consentTextVersion: "appointment-consent-v1" }
  });
  assert.equal(created.response.status, 201);
  const list = await request("/api/appointments", { token: tokens.super_admin });
  const id = list.data.appointments.find((item) => item.appointmentId === created.data.appointment.appointmentId)._id;
  const denied = await request(`/api/appointments/${id}/status`, { method: "PATCH", token: tokens.clinic_staff, body: { status: "completed" } });
  assert.equal(denied.response.status, 403);
  const allowed = await request(`/api/appointments/${id}/status`, { method: "PATCH", token: tokens.clinic_staff, body: { status: "arrived" } });
  assert.equal(allowed.response.status, 200);
});

test("public report submission requires verified appointment ownership", async () => {
  function reportForm(phone) {
    const form = new FormData();
    form.set("phone", phone);
    form.set("reportTitle", "Lab report");
    form.set("appointmentId", appointment.appointmentId);
    form.set("reportFile", new Blob([Buffer.from("%PDF-1.4\n%%EOF")], { type: "application/pdf" }), "report.pdf");
    return form;
  }
  const denied = await request("/api/reports/upload", { method: "POST", body: reportForm("03007654321") });
  assert.equal(denied.response.status, 404);
  const accepted = await request("/api/reports/upload", { method: "POST", body: reportForm("03001234567") });
  assert.equal(accepted.response.status, 201);
  assert.equal("patientPhone" in accepted.data.report, false);
});

test("authorized clinical, reception and operational mutations follow the matrix", async () => {
  const bookingDates = await request("/api/availability/dates?locationId=BWP&days=30");
  const staffDate = bookingDates.data.dates[0].date;
  const staffSlots = await request(`/api/availability/slots?locationId=BWP&date=${staffDate}`);
  const staffTime = staffSlots.data.slots.find((slot) => slot.available).time;
  const staffBooked = await request("/api/appointments/manual", {
    method: "POST", token: tokens.receptionist, headers: { "idempotency-key": "reception-booking" },
    body: { fullName: "Reception Booking", phone: "03007776666", reason: "Reception test", date: staffDate, time: staffTime, locationId: "BWP", consentGiven: true, consentTextVersion: "appointment-consent-v1" }
  });
  assert.equal(staffBooked.response.status, 201);
  const destinationDate = bookingDates.data.dates.find((entry) => entry.date !== staffDate).date;
  const destinationSlots = await request(`/api/availability/slots?locationId=BWP&date=${destinationDate}`);
  const destinationTime = destinationSlots.data.slots.find((slot) => slot.available).time;
  const staffRescheduled = await request(`/api/appointments/${staffBooked.data.appointment._id}/reschedule`, {
    method: "PATCH", token: tokens.receptionist,
    body: { date: destinationDate, time: destinationTime, locationId: "BWP", reason: "Reception reschedule" }
  });
  assert.equal(staffRescheduled.response.status, 200);
  assert.equal(staffRescheduled.data.appointment.status, "rescheduled");

  const reports = await request("/api/reports", { token: tokens.doctor });
  const reportId = reports.data.reports[0]._id;
  const reviewed = await request(`/api/reports/${reportId}/status`, { method: "PATCH", token: tokens.doctor, body: { status: "Reviewed" } });
  assert.equal(reviewed.response.status, 200);

  const submitted = await request("/api/online-consultations", {
    method: "POST",
    body: { fullName: "Consultation Patient", phone: "03001112222", symptoms: "Consultation test" }
  });
  assert.equal(submitted.response.status, 201);
  const consultations = await request("/api/online-consultations", { token: tokens.receptionist });
  const consultationId = consultations.data.consultations[0]._id;
  const scheduled = await request(`/api/online-consultations/${consultationId}/status`, { method: "PATCH", token: tokens.receptionist, body: { status: "Scheduled" } });
  assert.equal(scheduled.response.status, 200);
  const receptionClinicalUpdate = await request(`/api/online-consultations/${consultationId}/status`, { method: "PATCH", token: tokens.receptionist, body: { status: "Completed" } });
  assert.equal(receptionClinicalUpdate.response.status, 403);
  const completed = await request(`/api/online-consultations/${consultationId}/status`, { method: "PATCH", token: tokens.doctor, body: { status: "Completed", doctorNotes: "Reviewed" } });
  assert.equal(completed.response.status, 200);

  const handover = await request("/api/conversations", { method: "POST", body: { name: "Patient", phone: "03003334444", message: "Please contact me" } });
  assert.equal(handover.response.status, 201);
  const conversationId = handover.data.session.id;
  const staffMessage = await request(`/api/conversations/${conversationId}/messages`, { method: "POST", token: tokens.clinic_staff, body: { body: "Clinic response" } });
  assert.equal(staffMessage.response.status, 201);

  const bookingStarted = await request("/api/whatsapp/simulate-message", { method: "POST", token: tokens.receptionist, body: { phone: "03005556666", message: "I need an appointment Monday", language: "en" } });
  assert.match(bookingStarted.data.reply.body, /full name/i);
  await request("/api/whatsapp/simulate-message", { method: "POST", token: tokens.receptionist, body: { phone: "03005556666", message: "Consent Test Patient", language: "en" } });
  const timeQuestion = await request("/api/whatsapp/simulate-message", { method: "POST", token: tokens.receptionist, body: { phone: "03005556666", message: "Knee pain follow-up", language: "en" } });
  const timeId = timeQuestion.data.reply.buttons.find((button) => button.id.startsWith("AI_TIME_")).id;
  await request("/api/whatsapp/simulate-message", { method: "POST", token: tokens.receptionist, body: { phone: "03005556666", message: timeId, language: "en" } });
  await request("/api/whatsapp/simulate-message", { method: "POST", token: tokens.receptionist, body: { phone: "03005556666", message: "AI_REPORTS_NO", language: "en" } });
  const consentQuestion = await request("/api/whatsapp/simulate-message", { method: "POST", token: tokens.receptionist, body: { phone: "03005556666", message: "AI_SUMMARY_OK", language: "en" } });
  assert.match(consentQuestion.data.reply.body, /consent/i);
  const beforeConsent = await request("/api/whatsapp/simulate-message", { method: "POST", token: tokens.receptionist, body: { phone: "03005556666", message: "Patient Name", language: "en" } });
  assert.match(beforeConsent.data.reply.body, /consent is required/i);
  const consented = await request("/api/whatsapp/simulate-message", { method: "POST", token: tokens.receptionist, body: { phone: "03005556666", message: "AI_CONSENT_YES", language: "en" } });
  assert.match(consented.data.reply.body, /confirm/i);
});

test("security audit records preserve actor role, request ID, IP and user agent without content", async () => {
  await request("/api/patients", { token: tokens.doctor, headers: { "user-agent": "security-integration-test" } });
  const entry = await AuditLog.findOne({ action: "patients.list_viewed", actorRole: "doctor" }).sort({ createdAt: -1 }).lean();
  assert.ok(entry);
  assert.ok(entry.actorStaff);
  assert.ok(entry.requestId);
  assert.ok(entry.ip);
  assert.equal(entry.userAgent, "security-integration-test");
  assert.equal(JSON.stringify(entry).includes("Security Test Patient"), false);
});

test("CORS rejects unknown origins and permits configured production origins", async () => {
  const denied = await request("/api/clinic-locations/public", { origin: "https://evil.example" });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.data.error.code, "FORBIDDEN");
  const allowed = await request("/api/clinic-locations/public", { origin: "https://clinic.example" });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.response.headers.get("access-control-allow-origin"), "https://clinic.example");
});

test("Meta verification and signed callbacks work while invalid signatures fail", async () => {
  const verifyDenied = await request("/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123");
  assert.equal(verifyDenied.response.status, 403);

  const verifyAccepted = await request("/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=integration-verify-token&hub.challenge=123");
  assert.equal(verifyAccepted.response.status, 200);
  assert.equal(verifyAccepted.text, "123");

  const rawBody = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: { statuses: [{ id: "wamid.integration", recipient_id: "923001234567", status: "delivered", timestamp: "1786217000" }] } }] }]
  });
  const signature = `sha256=${crypto.createHmac("sha256", process.env.META_APP_SECRET).update(rawBody).digest("hex")}`;
  const accepted = await request("/api/whatsapp/webhook", { method: "POST", rawBody, headers: { "x-hub-signature-256": signature } });
  assert.equal(accepted.response.status, 200);
  const duplicate = await request("/api/whatsapp/webhook", { method: "POST", rawBody, headers: { "x-hub-signature-256": signature } });
  assert.equal(duplicate.response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await MessageDeliveryStatus.countDocuments({ metaMessageId: "wamid.integration" }), 1);
  const denied = await request("/api/whatsapp/webhook", { method: "POST", rawBody, headers: { "x-hub-signature-256": "sha256=invalid" } });
  assert.equal(denied.response.status, 403);
});

test("source and configuration files are not publicly served", async () => {
  for (const path of ["/server.js", "/package.json", "/.env", "/%2eenv", "/.env.example", "/README.md", "/src/config/env.js", "/tests/unit/core.test.js", "/%2e%2e/server.js"]) {
    const result = await request(path);
    assert.equal(result.response.status, 404, path);
    assert.equal(result.text.includes("JWT_ACCESS_SECRET"), false, path);
  }
  assert.equal((await request("/")).response.status, 200);
  assert.equal((await request("/script.js")).response.status, 200);
});
