const crypto = require("crypto");
const {
  Appointment,
  BookingRequest,
  Counter,
  Patient,
  PatientConsent,
  RescheduleHistory
} = require("../models");
const { badRequest, conflict, notFound } = require("../utils/errors");
const { maskPhone, normalizePhone, safePublicAppointment } = require("../utils/security");
const { normalizeTime } = require("../utils/time");
const { ensureSlotBookable } = require("./availabilityService");
const { getBookableLocation } = require("./locationService");
const { audit } = require("./auditService");
const { config } = require("../config/env");
const { logError } = require("../utils/safeLogger");
const {
  OCCUPYING_APPOINTMENT_STATUSES,
  appointmentOccupiesSlot,
  canTransitionAppointmentStatus,
  activeSlotKey
} = require("../domain/appointmentRules");

const ELIGIBLE_RESCHEDULE_STATUSES = OCCUPYING_APPOINTMENT_STATUSES;

async function nextSequence(key) {
  const counter = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
}

async function prepareGlobalAppointmentCounter(year) {
  const existing = await Appointment.find({ appointmentId: new RegExp(`^DS-${year}-\\d+$`) })
    .select("appointmentId")
    .lean();
  const maximum = existing.reduce((max, item) => {
    const sequence = Number(String(item.appointmentId).split("-").pop());
    return Number.isSafeInteger(sequence) ? Math.max(max, sequence) : max;
  }, 0);
  await Counter.updateOne(
    { key: `appointment:${year}` },
    { $max: { seq: maximum }, $setOnInsert: { key: `appointment:${year}` } },
    { upsert: true }
  );
}

async function generateAppointmentId(location, date) {
  const year = String(date).slice(0, 4);
  await prepareGlobalAppointmentCounter(year);
  const seq = await nextSequence(`appointment:${year}`);
  return formatAppointmentId(location?.code, year, seq);
}

function formatAppointmentId(locationCode, year, sequence) {
  return `DS-${year}-${String(sequence).padStart(4, "0")}`;
}

async function findOrCreatePatient(input) {
  const phoneE164 = normalizePhone(input.phone);
  if (!phoneE164) throw badRequest("A valid phone number is required.");

  const existing = await Patient.findOne({ phoneE164 });
  const preservePrimary = existing && input.patientFor === "family";
  const update = {
    $set: {
      fullName: preservePrimary ? existing.fullName : input.fullName,
      age: preservePrimary ? existing.age : input.age,
      gender: input.gender || "not_provided",
      preferredLanguage: input.preferredLanguage || "en"
    }
  };
  try {
    const patient = await Patient.findOneAndUpdate(
      { phoneE164 },
      update,
      { new: true, upsert: true, runValidators: true }
    );
    if (input.patientFor && input.fullName) {
      const normalizedName = String(input.fullName).trim().toLocaleLowerCase("en");
      patient.knownProfiles = (patient.knownProfiles || []).filter((profile) => profile.normalizedName !== normalizedName).slice(-19);
      patient.knownProfiles.push({
        normalizedName,
        fullName: String(input.fullName).trim(),
        ...(Number.isInteger(input.age) ? { age: input.age } : {}),
        relationship: input.patientFor,
        lastVerifiedAt: new Date()
      });
      await patient.save();
    }
    return patient;
  } catch (error) {
    if (error.code !== 11000) throw error;
    return Patient.findOneAndUpdate({ phoneE164 }, update, { new: true, runValidators: true });
  }
}

async function createConsent({ patient, phoneE164, consentGiven, channel, language }) {
  return PatientConsent.create({
    patient: patient._id,
    phoneE164,
    consentGiven,
    channel,
    language: language || "en",
    consentText: config.appointmentConsent.text,
    consentTextVersion: config.appointmentConsent.version,
    consentedAt: new Date()
  });
}

async function recordConsentDecision(input, source, options = {}) {
  if (typeof input.consentGiven !== "boolean") throw badRequest("An explicit consent decision is required.");
  if (input.consentTextVersion && input.consentTextVersion !== config.appointmentConsent.version) {
    throw badRequest("The consent statement has changed. Please review the current statement.");
  }
  const patient = await findOrCreatePatient(input);
  const consent = await createConsent({
    patient,
    phoneE164: patient.phoneE164,
    consentGiven: input.consentGiven,
    channel: source,
    language: input.preferredLanguage || patient.preferredLanguage
  });
  await audit({
    actorType: source === "staff" ? "staff" : "patient",
    actorStaff: options.staffUser?._id,
    actorPatient: source === "staff" ? undefined : patient._id,
    actorPhone: source === "staff" ? undefined : patient.phoneE164,
    action: input.consentGiven ? "consent.accepted" : "consent.declined",
    entityType: "patient_consent",
    entityId: String(consent._id),
    metadata: { source, consentGiven: input.consentGiven, consentTextVersion: consent.consentTextVersion },
    req: options.req
  });
  return { patient, consent };
}

function normalizedIdempotencyKey(source, value) {
  const key = String(value || "").trim();
  if (!key) return undefined;
  if (key.length > 250) throw badRequest("Idempotency key is too long.");
  return `${source}:${key}`;
}

function bookingFingerprint(input, source, locationId, time, phoneE164) {
  const stable = JSON.stringify({
    source,
    locationId: String(locationId),
    date: input.date,
    time,
    phoneE164,
    fullName: String(input.fullName || "").trim(),
    appointmentType: input.appointmentType || "in_person"
  });
  return crypto.createHash("sha256").update(stable).digest("hex");
}

async function findIdempotentAppointment(key, fingerprint) {
  if (!key) return null;
  const existing = await Appointment.findOne({ idempotencyKey: key });
  if (!existing) return null;
  if (existing.idempotencyFingerprint !== fingerprint) {
    throw conflict("This booking request key was already used for different appointment details.");
  }
  return existing;
}

async function acquireBookingRequest(key, fingerprint) {
  if (!key) return { owner: true };
  try {
    const request = await BookingRequest.create({
      key,
      fingerprint,
      status: "processing",
      leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000)
    });
    return { owner: true, request };
  } catch (error) {
    if (error.code !== 11000) throw error;
  }

  let request = await BookingRequest.findOne({ key });
  if (!request || request.fingerprint !== fingerprint) {
    throw conflict("This booking request key was already used for different appointment details.");
  }
  if (request.status === "completed" && request.appointment) {
    return { owner: false, appointment: await Appointment.findById(request.appointment) };
  }
  if (request.status === "failed" || request.leaseExpiresAt <= new Date()) {
    request = await BookingRequest.findOneAndUpdate(
      { _id: request._id, status: request.status, leaseExpiresAt: request.leaseExpiresAt },
      { $set: { status: "processing", leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000) }, $unset: { errorCode: "", appointment: "" } },
      { new: true }
    );
    if (request) return { owner: true, request };
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    request = await BookingRequest.findOne({ key });
    if (request?.fingerprint !== fingerprint) throw conflict("This booking request key was already used for different appointment details.");
    if (request?.status === "completed" && request.appointment) {
      return { owner: false, appointment: await Appointment.findById(request.appointment) };
    }
    if (request?.status === "failed") throw conflict("The original booking request failed. Please retry with the same request key.");
  }
  throw conflict("The original booking request is still processing. Please retry shortly.");
}

function isDuplicateFor(error, field) {
  return error?.code === 11000 && (error?.keyPattern?.[field] || Object.prototype.hasOwnProperty.call(error?.keyValue || {}, field));
}

async function recalculateQueueTokens(locationId, date) {
  const appointments = await Appointment.find({
    location: locationId,
    date,
    status: { $in: OCCUPYING_APPOINTMENT_STATUSES }
  }).sort({ time: 1, createdAt: 1, _id: 1 }).select("_id tokenNumber").lean();

  if (!appointments.length) return;
  await Appointment.bulkWrite(appointments.map((appointment, index) => ({
    updateOne: {
      filter: { _id: appointment._id },
      update: { $set: { tokenNumber: String(index + 1).padStart(3, "0") } }
    }
  })));
}

async function runPostBookingTasks(appointment, input) {
  const apptType = input.appointmentType || "in_person";
  if (String(apptType).toLowerCase() === "online") {
    const { OnlineConsultation } = require("../models");
    await OnlineConsultation.create({
      consultationId: `VRT-${appointment.appointmentId.replace(/\D/g, "").slice(-8)}`,
      patient: appointment.patient,
      fullName: input.fullName,
      contactPhone: appointment.phoneE164,
      symptoms: input.reason || "Virtual Online Consultation",
      preferredDate: appointment.date,
      preferredTime: appointment.time,
      status: "Scheduled"
    }).catch(() => undefined);
  }
  const { scheduleAppointmentReminders } = require("./reminderService");
  const reminderJobs = await scheduleAppointmentReminders(appointment).catch(async (error) => {
    logError("Appointment reminder scheduling failed", error);
    await Appointment.updateOne({ _id: appointment._id }, { $set: { reminderStatus: "failed" } }).catch(() => undefined);
    return [];
  });
  const { enqueueOwnerAppointmentEmail, kickOwnerEmailWorker } = require("./ownerEmailOutboxService");
  const ownerEmail = await enqueueOwnerAppointmentEmail(appointment).catch((error) => {
    logError("Owner appointment email queueing failed", error);
    return null;
  });
  if (ownerEmail) kickOwnerEmailWorker(ownerEmail._id);
  appointment.$locals.reminderJobsCreated = reminderJobs.length;
  appointment.$locals.ownerEmailOutboxId = ownerEmail?._id;
}

async function createAppointment(input, options = {}) {
  const source = options.source || input.source || "whatsapp";
  if (input.consentTextVersion && input.consentTextVersion !== config.appointmentConsent.version) {
    throw badRequest("The consent statement has changed. Please review and accept the current statement.");
  }
  if (input.consentGiven !== true) {
    if (input.consentGiven === false) await recordConsentDecision(input, source, options);
    throw badRequest("Active patient consent is required before booking an appointment.");
  }

  const time = normalizeTime(input.time);
  if (!time) throw badRequest("Use a valid appointment time.");
  const location = await getBookableLocation(input.locationId || "BWP");
  const patient = await findOrCreatePatient(input);
  const phoneE164 = patient.phoneE164;
  const idempotencyKey = normalizedIdempotencyKey(source, options.idempotencyKey || input.idempotencyKey);
  const idempotencyFingerprint = bookingFingerprint(input, source, location._id, time, phoneE164);
  const bookingRequest = await acquireBookingRequest(idempotencyKey, idempotencyFingerprint);
  if (!bookingRequest.owner) return bookingRequest.appointment;
  const prior = await findIdempotentAppointment(idempotencyKey, idempotencyFingerprint);
  if (prior) {
    if (bookingRequest.request) await BookingRequest.updateOne({ _id: bookingRequest.request._id }, { $set: { status: "completed", appointment: prior._id } });
    return prior;
  }

  let slot;
  try {
    slot = await ensureSlotBookable(location._id, input.date, time);
    const activeDuplicate = await Appointment.findOne({
      phoneE164,
      location: location._id,
      date: input.date,
      status: { $in: OCCUPYING_APPOINTMENT_STATUSES }
    });
    if (activeDuplicate) throw conflict("This patient already has an active appointment on the selected date.");
  } catch (error) {
    if (bookingRequest.request) await BookingRequest.updateOne({ _id: bookingRequest.request._id }, { $set: { status: "failed", errorCode: error.code || "BOOKING_FAILED" } });
    throw error;
  }

  let consent;
  let appointmentId;
  try {
    consent = await createConsent({
      patient,
      phoneE164,
      consentGiven: input.consentGiven,
      channel: source,
      language: input.preferredLanguage || patient.preferredLanguage
    });
    appointmentId = await generateAppointmentId(location, input.date);
  } catch (error) {
    if (consent) await PatientConsent.deleteOne({ _id: consent._id }).catch(() => undefined);
    if (bookingRequest.request) await BookingRequest.updateOne({ _id: bookingRequest.request._id }, { $set: { status: "failed", errorCode: error.code || "BOOKING_FAILED" } });
    throw error;
  }
  const appointmentData = {
    appointmentId,
    tokenNumber: "001",
    appointmentType: input.appointmentType || "in_person",
    patient: patient._id,
    patientSnapshot: {
      fullName: input.fullName,
      phoneMasked: maskPhone(phoneE164),
      age: input.age,
      gender: input.gender || "not_provided",
      preferredLanguage: input.preferredLanguage || patient.preferredLanguage || "en"
    },
    phoneE164,
    location: location._id,
    locationSnapshot: {
      clinicName: location.clinicName,
      city: location.city,
      code: location.code,
      address: location.fullAddress,
      contactNumber: location.contactNumber,
      timezone: location.timezone
    },
    reason: input.reason || "General Consultation",
    optionalNote: input.optionalNote || "",
    date: input.date,
    time,
    slotTimezone: location.timezone,
    activeSlotKey: slot.slotKey,
    idempotencyKey,
    idempotencyFingerprint: idempotencyKey ? idempotencyFingerprint : undefined,
    status: "confirmed",
    consent: consent._id,
    source,
    createdBy: options.staffUser?._id
  };

  let appointment;
  try {
    appointment = await Appointment.create(appointmentData);
  } catch (error) {
    await PatientConsent.deleteOne({ _id: consent._id }).catch(() => undefined);
    if (isDuplicateFor(error, "idempotencyKey")) {
      const repeated = await findIdempotentAppointment(idempotencyKey, idempotencyFingerprint);
      if (repeated) return repeated;
    }
    if (bookingRequest.request) await BookingRequest.updateOne({ _id: bookingRequest.request._id }, { $set: { status: "failed", errorCode: error.code || "BOOKING_FAILED" } });
    if (isDuplicateFor(error, "activeSlotKey")) throw conflict("Slot no longer available");
    if (isDuplicateFor(error, "appointmentId")) throw conflict("Appointment identifier collision. Please retry the request.");
    if (error.code === 11000) throw conflict("Slot no longer available");
    throw error;
  }

  await recalculateQueueTokens(location._id, input.date);
  appointment = await Appointment.findById(appointment._id);
  if (bookingRequest.request) {
    await BookingRequest.updateOne(
      { _id: bookingRequest.request._id },
      { $set: { status: "completed", appointment: appointment._id }, $unset: { errorCode: "" } }
    );
  }
  await runPostBookingTasks(appointment, input);
  if (!options.skipNotification) {
    const { sendAppointmentConfirmation } = require("./appointmentNotificationService");
    appointment.$locals.whatsappNotification = await sendAppointmentConfirmation(appointment).catch(() => ({ status: "failed" }));
  }
  await audit({
    actorType: source === "staff" ? "staff" : "patient",
    actorStaff: options.staffUser?._id,
    actorPatient: source === "staff" ? undefined : patient._id,
    actorPhone: source === "staff" ? undefined : phoneE164,
    action: "appointment.created",
    entityType: "appointment",
    entityId: appointment.appointmentId,
    metadata: { source },
    after: { status: appointment.status, date: appointment.date, time: appointment.time, location: String(appointment.location) },
    req: options.req
  });
  return appointment;
}

async function lookupAppointment({ appointmentId, phone, reference, phoneNumber }) {
  const ref = String(reference || appointmentId || "").trim().replace(/^#/, "");
  const phoneE164 = normalizePhone(phone || phoneNumber || "");
  if (!ref || !phoneE164) throw badRequest("Appointment ID and a valid phone number are required.");
  const refEscaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const appointment = await Appointment.findOne({
    phoneE164,
    $or: [
      { appointmentId: new RegExp(`^${refEscaped}$`, "i") },
      { tokenNumber: new RegExp(`^#?${refEscaped}$`, "i") }
    ]
  }).sort({ createdAt: -1 })
    .populate("patient", "patientId fullName phoneE164 preferredLanguage age city gender")
    .populate("location", "clinicName city code fullAddress contactNumber timezone");
  if (!appointment) throw notFound("Appointment was not found for the provided details.");
  return appointment;
}

async function listAppointments(query = {}) {
  const filter = {};
  const allowedStatuses = new Set([...OCCUPYING_APPOINTMENT_STATUSES, "completed", "cancelled", "no_show"]);
  if (allowedStatuses.has(query.status)) filter.status = query.status;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.date || ""))) filter.date = query.date;
  if (query.from || query.to) {
    filter.date = {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.from || ""))) filter.date.$gte = query.from;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.to || ""))) filter.date.$lte = query.to;
    if (!Object.keys(filter.date).length) delete filter.date;
  }
  if (query.search) {
    const search = String(query.search).slice(0, 120);
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const phone = normalizePhone(search);
    filter.$or = [
      { appointmentId: new RegExp(escaped, "i") },
      { "patientSnapshot.fullName": new RegExp(escaped, "i") },
      { tokenNumber: new RegExp(escaped, "i") }
    ];
    if (phone) filter.$or.push({ phoneE164: phone });
  }
  const limit = Math.max(1, Math.min(Number(query.limit) || 100, 300));
  const page = Math.max(1, Number(query.page) || 1);
  return Appointment.find(filter).sort({ date: 1, time: 1 }).skip((page - 1) * limit).limit(limit)
    .populate("patient", "patientId fullName phoneE164 preferredLanguage age city gender")
    .populate("location", "clinicName city code fullAddress contactNumber timezone")
    .lean();
}

async function getAppointmentById(id) {
  const appointment = await Appointment.findById(id).populate("patient location");
  if (!appointment) throw notFound("Appointment was not found.");
  return appointment;
}

function locationIdFrom(value) {
  return value?._id || value;
}

async function rescheduleAppointment({ appointmentId, phone, locationId, date, time, reason }, options = {}) {
  const existing = options.staffUser
    ? await Appointment.findOne({
      $or: [
        { appointmentId },
        ...(/^[a-f\d]{24}$/i.test(String(appointmentId || "")) ? [{ _id: appointmentId }] : [])
      ]
    }).populate("location")
    : await lookupAppointment({ appointmentId, phone });
  if (!existing) throw notFound("Appointment was not found.");
  if (!ELIGIBLE_RESCHEDULE_STATUSES.includes(existing.status)) throw conflict("This appointment can no longer be rescheduled.");

  const normalizedTime = normalizeTime(time);
  if (!normalizedTime) throw badRequest("Use a valid appointment time.");
  const previousLocation = locationIdFrom(existing.location);
  const targetLocation = await getBookableLocation(locationId || previousLocation);
  if (String(previousLocation) === String(targetLocation._id) && existing.date === date && existing.time === normalizedTime) return existing;
  const slot = await ensureSlotBookable(targetLocation._id, date, normalizedTime);
  const history = {
    previousLocation,
    previousDate: existing.date,
    previousTime: existing.time,
    newLocation: targetLocation._id,
    newDate: date,
    newTime: normalizedTime,
    changedByType: options.staffUser ? "staff" : "patient",
    changedByStaff: options.staffUser?._id,
    reason: reason || "Patient requested reschedule",
    changedAt: new Date()
  };

  let appointment;
  try {
    appointment = await Appointment.findOneAndUpdate(
      { _id: existing._id, status: existing.status, location: previousLocation, date: existing.date, time: existing.time },
      {
        $set: {
          location: targetLocation._id,
          locationSnapshot: {
            clinicName: targetLocation.clinicName,
            city: targetLocation.city,
            code: targetLocation.code,
            address: targetLocation.fullAddress,
            contactNumber: targetLocation.contactNumber,
            timezone: targetLocation.timezone
          },
          date,
          time: normalizedTime,
          slotTimezone: targetLocation.timezone,
          activeSlotKey: slot.slotKey,
          status: "rescheduled"
        },
        $inc: { rescheduleCount: 1 },
        $push: { rescheduleHistory: history }
      },
      { new: true, runValidators: true }
    );
  } catch (error) {
    if (isDuplicateFor(error, "activeSlotKey") || error.code === 11000) throw conflict("Slot no longer available");
    throw error;
  }
  if (!appointment) throw conflict("The appointment changed during rescheduling. Please retry.");

  await RescheduleHistory.create({ appointment: appointment._id, ...history }).catch(() => undefined);
  await Promise.all([
    recalculateQueueTokens(previousLocation, existing.date),
    recalculateQueueTokens(targetLocation._id, date)
  ]);
  appointment = await Appointment.findById(appointment._id);
  const { cancelAppointmentReminders, scheduleAppointmentReminders } = require("./reminderService");
  await cancelAppointmentReminders(appointment._id).catch(() => undefined);
  await scheduleAppointmentReminders(appointment).catch(() => undefined);
  if (!options.skipNotification) {
    const { sendRescheduleConfirmation } = require("./appointmentNotificationService");
    appointment.$locals.whatsappNotification = await sendRescheduleConfirmation(appointment).catch(() => ({ status: "failed" }));
  }
  await audit({
    actorType: options.staffUser ? "staff" : "patient",
    actorStaff: options.staffUser?._id,
    actorPatient: options.staffUser ? undefined : appointment.patient,
    actorPhone: options.staffUser ? undefined : appointment.phoneE164,
    action: "appointment.rescheduled",
    entityType: "appointment",
    entityId: appointment.appointmentId,
    metadata: {
      previousLocation: String(previousLocation), previousDate: existing.date, previousTime: existing.time,
      newLocation: String(targetLocation._id), newDate: date, newTime: normalizedTime
    },
    before: { location: String(previousLocation), date: existing.date, time: existing.time, status: existing.status },
    after: { location: String(targetLocation._id), date, time: normalizedTime, status: appointment.status },
    req: options.req
  });
  return appointment;
}

async function cancelAppointment({ appointmentId, phone, reason }, options = {}) {
  const existing = options.staffUser
    ? await Appointment.findOne({ appointmentId })
    : await lookupAppointment({ appointmentId, phone });
  if (!existing) throw notFound("Appointment was not found.");
  if (existing.status === "cancelled") return existing;
  if (["completed", "no_show"].includes(existing.status)) throw conflict("This appointment can no longer be cancelled.");

  const locationId = locationIdFrom(existing.location);
  const appointment = await Appointment.findOneAndUpdate(
    { _id: existing._id, status: existing.status },
    {
      $set: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancellationReason: reason || "",
        cancellationSource: options.staffUser ? "staff" : (options.source || existing.source || "website"),
        cancelledBy: options.staffUser?._id,
        reminderStatus: "cancelled"
      },
      $unset: { activeSlotKey: "" }
    },
    { new: true, runValidators: true }
  );
  if (!appointment) {
    const current = await Appointment.findById(existing._id);
    if (current?.status === "cancelled") return current;
    throw conflict("The appointment changed during cancellation. Please retry.");
  }
  await recalculateQueueTokens(locationId, existing.date);
  const { cancelAppointmentReminders } = require("./reminderService");
  await cancelAppointmentReminders(appointment._id).catch(() => undefined);
  if (!options.skipNotification) {
    const { sendCancellationConfirmation } = require("./appointmentNotificationService");
    appointment.$locals.whatsappNotification = await sendCancellationConfirmation(appointment).catch(() => ({ status: "failed" }));
  }
  await audit({
    actorType: options.staffUser ? "staff" : "patient",
    actorStaff: options.staffUser?._id,
    actorPatient: options.staffUser ? undefined : appointment.patient,
    actorPhone: options.staffUser ? undefined : appointment.phoneE164,
    action: "appointment.cancelled",
    entityType: "appointment",
    entityId: appointment.appointmentId,
    metadata: { source: options.staffUser ? "staff" : (options.source || existing.source), reasonProvided: Boolean(reason) },
    before: { status: existing.status },
    after: { status: appointment.status },
    req: options.req
  });
  return appointment;
}

async function updateAppointmentStatus(id, status, options = {}) {
  const existing = await Appointment.findById(id);
  if (!existing) throw notFound("Appointment was not found.");
  if (!canTransitionAppointmentStatus(existing.status, status)) {
    throw conflict(`Appointment status cannot change from ${existing.status} to ${status}.`);
  }
  if (existing.status === status) return existing;

  const update = { $set: { status }, $unset: {} };
  if (appointmentOccupiesSlot(status)) {
    await ensureSlotBookableForSelf(existing);
    update.$set.activeSlotKey = activeSlotKey(existing.location, existing.date, existing.time);
    update.$set.slotTimezone = existing.slotTimezone || existing.locationSnapshot?.timezone || "Asia/Karachi";
  } else {
    update.$unset.activeSlotKey = "";
  }
  if (status === "completed") update.$set.completedAt = new Date();
  if (status === "arrived") update.$set.arrivedAt = new Date();
  if (status === "cancelled") {
    update.$set.cancelledAt = new Date();
    update.$set.cancellationSource = "staff";
    update.$set.cancellationReason = options.reason || "";
    update.$set.cancelledBy = options.staffUser?._id;
    update.$set.reminderStatus = "cancelled";
  }
  if (!Object.keys(update.$unset).length) delete update.$unset;

  let appointment;
  try {
    appointment = await Appointment.findOneAndUpdate(
      { _id: existing._id, status: existing.status },
      update,
      { new: true, runValidators: true }
    );
  } catch (error) {
    if (isDuplicateFor(error, "activeSlotKey") || error.code === 11000) throw conflict("Slot no longer available");
    throw error;
  }
  if (!appointment) throw conflict("The appointment status changed concurrently. Please retry.");
  await recalculateQueueTokens(existing.location, existing.date);
  if (["cancelled", "completed", "no_show"].includes(status)) {
    const { cancelAppointmentReminders } = require("./reminderService");
    await cancelAppointmentReminders(appointment._id).catch(() => undefined);
  } else if (status === "confirmed") {
    const { scheduleAppointmentReminders } = require("./reminderService");
    await scheduleAppointmentReminders(appointment).catch(() => undefined);
  }
  await audit({
    actorType: options.staffUser ? "staff" : "patient",
    actorStaff: options.staffUser?._id,
    action: `appointment.${status}`,
    entityType: "appointment",
    entityId: appointment.appointmentId,
    metadata: { previousStatus: existing.status, newStatus: status },
    before: { status: existing.status },
    after: { status },
    req: options.req
  });
  return appointment;
}

async function ensureSlotBookableForSelf(appointment) {
  const conflictAppointment = await Appointment.findOne({
    _id: { $ne: appointment._id },
    location: appointment.location,
    date: appointment.date,
    time: appointment.time,
    status: { $in: OCCUPYING_APPOINTMENT_STATUSES }
  });
  if (conflictAppointment) throw conflict("Slot no longer available");
}

async function requestEarlierSlot(appointmentId, phone, notes) {
  const existing = await lookupAppointment({ appointmentId, phone });
  if (!canTransitionAppointmentStatus(existing.status, "waiting_for_earlier_slot")) {
    throw conflict("This appointment is not eligible for an earlier-slot request.");
  }
  const note = notes ? `${existing.optionalNote ? `${existing.optionalNote} | ` : ""}Earlier slot request: ${notes}` : existing.optionalNote;
  return Appointment.findOneAndUpdate(
    { _id: existing._id, status: existing.status },
    { $set: { status: "waiting_for_earlier_slot", optionalNote: note } },
    { new: true, runValidators: true }
  );
}

module.exports = {
  createAppointment,
  findOrCreatePatient,
  lookupAppointment,
  listAppointments,
  getAppointmentById,
  rescheduleAppointment,
  cancelAppointment,
  updateAppointmentStatus,
  requestEarlierSlot,
  recalculateQueueTokens,
  generateAppointmentId,
  formatAppointmentId,
  recordConsentDecision,
  safePublicAppointment
};
