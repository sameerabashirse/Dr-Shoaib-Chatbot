const mongoose = require("mongoose");
const {
  Appointment,
  Counter,
  ClinicLocation,
  Patient,
  PatientConsent,
  RescheduleHistory
} = require("../models");
const { badRequest, conflict, notFound } = require("../utils/errors");
const { config } = require("../config/env");
const { maskPhone, normalizePhone, safePublicAppointment } = require("../utils/security");
const { normalizeTime, slotKey, activePatientDateKey, tokenNumberForTime } = require("../utils/time");
const { ensureSlotBookable } = require("./availabilityService");
const { getBookableLocation } = require("./locationService");
const { audit } = require("./auditService");

const activeStatuses = [
  "pending",
  "confirmed",
  "patient_confirmed",
  "arrived",
  "in_consultation",
  "rescheduled",
  "waiting_for_earlier_slot",
  "scheduled"
];

async function nextSequence(key) {
  const counter = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
}

async function generateAppointmentId(location, date) {
  const year = String(date).slice(0, 4);
  const seq = await nextSequence(`appointment:${location.code}:${year}`);
  return formatAppointmentId(location.code, year, seq);
}

function formatAppointmentId(locationCode, year, sequence) {
  return `DS-${year}-${String(sequence).padStart(4, "0")}`;
}

async function findOrCreatePatient(input) {
  const phoneE164 = normalizePhone(input.phone);
  if (!phoneE164) throw badRequest("A valid phone number is required.");

  return Patient.findOneAndUpdate(
    { phoneE164 },
    {
      $set: {
        fullName: input.fullName,
        age: input.age,
        gender: input.gender || "not_provided",
        preferredLanguage: input.preferredLanguage || "en"
      }
    },
    { new: true, upsert: true, runValidators: true }
  );
}

async function createConsent({ patient, phoneE164, consentGiven, channel, language }) {
  return PatientConsent.create({
    patient: patient._id,
    phoneE164,
    consentGiven,
    channel,
    language: language || "en",
    consentText: "Patient information will be used for appointment management, reminders, rescheduling, and clinic communications for Dr. Sohaib.",
    consentedAt: new Date()
  });
}

async function createAppointment(input, options = {}) {
  const source = options.source || input.source || "whatsapp";
  if (!input.consentGiven && source !== "staff") {
    throw badRequest("Patient consent is required before collecting appointment information.");
  }

  const time = normalizeTime(input.time);
  if (!time) throw badRequest("Use a valid appointment time.");
  const location = await getBookableLocation(input.locationId || "BWP");
  await ensureSlotBookable(location._id, input.date, time);

  const patient = await findOrCreatePatient(input);
  const phoneE164 = patient.phoneE164;

  const activeDuplicate = await Appointment.findOne({
    phoneE164,
    location: location._id,
    date: input.date,
    status: { $in: activeStatuses }
  });
  if (activeDuplicate) {
    throw conflict("This patient already has an active appointment on the selected date.");
  }

  const consent = await createConsent({
    patient,
    phoneE164,
    consentGiven: Boolean(input.consentGiven || source === "staff"),
    channel: source,
    language: input.preferredLanguage || patient.preferredLanguage
  });

  const appointmentId = await generateAppointmentId(location, input.date);
  const tokenNumber = tokenNumberForTime(location, input.date, time) || "001";

  try {
    const apptType = input.appointmentType || "in_person";
    const appointmentData = {
      appointmentId,
      tokenNumber,
      appointmentType: apptType,
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
      status: "confirmed",
      consent: consent._id,
      source,
      createdBy: options.staffUser?._id
    };

    const appointment = await Appointment.create(appointmentData);

    // If Online Appointment, sync with OnlineConsultation record
    if (String(apptType).toLowerCase() === "online") {
      const { OnlineConsultation } = require("../models");
      await OnlineConsultation.create({
        consultationId: `VRT-${Date.now().toString().slice(-6)}`,
        patient: patient._id,
        fullName: input.fullName,
        contactPhone: phoneE164,
        symptoms: input.reason || "Virtual Online Consultation",
        preferredDate: input.date,
        preferredTime: time,
        status: "Scheduled"
      }).catch(() => {});
    }

    const { scheduleAppointmentReminders } = require("./reminderService");
    await scheduleAppointmentReminders(appointment).catch((error) => {
      console.error("Appointment reminder scheduling failed.", {
        appointmentId: appointment.appointmentId,
        name: error?.name || "ReminderError",
        code: error?.code || "REMINDER_SCHEDULING_FAILED"
      });
    });

    await audit({
      actorType: source === "staff" ? "staff" : "patient",
      actorStaff: options.staffUser?._id,
      actorPhone: source === "staff" ? undefined : phoneE164,
      action: "appointment.created",
      entityType: "appointment",
      entityId: appointment.appointmentId,
      req: options.req
    }).catch((error) => {
      console.error("Appointment audit logging failed.", {
        appointmentId: appointment.appointmentId,
        name: error?.name || "AuditError",
        code: error?.code || "APPOINTMENT_AUDIT_FAILED"
      });
    });

    return appointment;
  } catch (error) {
    if (error.code === 11000) {
      throw conflict("The selected slot or token was just taken. Please choose another available slot.");
    }
    throw error;
  }
}

async function lookupAppointment({ appointmentId, phone, reference, phoneNumber }) {
  const refInput = reference || appointmentId || "";
  const ref = String(refInput).trim().replace(/^#/, "");
  const phoneInput = phone || phoneNumber || "";
  if (!ref) throw badRequest("Appointment ID or Token Number is required.");

  const normalizedPhoneE164 = normalizePhone(phoneInput);
  const rawDigits = String(phoneInput || "").replace(/\D/g, "");
  const last10Digits = rawDigits.length >= 10 ? rawDigits.slice(-10) : rawDigits;

  const phoneQuery = {
    $or: [
      { phoneE164: normalizedPhoneE164 },
      ...(last10Digits ? [{ phoneE164: { $regex: last10Digits, $options: "i" } }] : [])
    ]
  };

  const refEscaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const refRegex = new RegExp(`^${refEscaped}$`, "i");
  const tokenRegex = new RegExp(`^#?${refEscaped}$`, "i");

  const appointment = await Appointment.findOne({
    $and: [
      {
        $or: [
          { appointmentId: refRegex },
          { tokenNumber: tokenRegex }
        ]
      },
      phoneQuery
    ]
  }).populate("patient location");

  if (!appointment) throw notFound("Appointment was not found for the provided details.");
  return appointment;
}

async function listAppointments(query = {}) {
  const filter = {};
  if (query.status && query.status !== "all") filter.status = query.status;
  if (query.date) filter.date = query.date;
  if (query.from || query.to) {
    filter.date = {};
    if (query.from) filter.date.$gte = query.from;
    if (query.to) filter.date.$lte = query.to;
  }
  if (query.search) {
    const phone = normalizePhone(query.search);
    filter.$or = [
      { appointmentId: new RegExp(query.search, "i") },
      { "patientSnapshot.fullName": new RegExp(query.search, "i") },
      { tokenNumber: new RegExp(query.search, "i") }
    ];
    if (phone) filter.$or.push({ phoneE164: phone });
  }

  const limit = Math.min(Number(query.limit) || 100, 300);
  return Appointment.find(filter).sort({ date: 1, time: 1 }).limit(limit).populate("patient location").lean();
}

async function getAppointmentById(id) {
  const appointment = await Appointment.findById(id).populate("patient location");
  if (!appointment) throw notFound("Appointment was not found.");
  return appointment;
}

async function rescheduleAppointment({ appointmentId, phone, date, time, reason }, options = {}) {
  const appointment = options.staffUser
    ? await Appointment.findOne({ appointmentId })
    : await lookupAppointment({ appointmentId, phone });

  if (!appointment) throw notFound("Appointment was not found.");

  const normalizedTime = normalizeTime(time);
  if (!normalizedTime) throw badRequest("Use a valid appointment time.");

  const location = await getBookableLocation(appointment.location);
  await ensureSlotBookable(location._id, date, normalizedTime);

  const previousDate = appointment.date;
  const previousTime = appointment.time;

  appointment.date = date;
  appointment.time = normalizedTime;
  appointment.status = "rescheduled";
  appointment.tokenNumber = tokenNumberForTime(location, date, normalizedTime) || "001";
  appointment.rescheduleCount += 1;

  await appointment.save();

  await RescheduleHistory.create({
    appointment: appointment._id,
    previousDate,
    previousTime,
    newDate: date,
    newTime: normalizedTime,
    changedByType: options.staffUser ? "staff" : "patient",
    changedByStaff: options.staffUser?._id,
    reason: reason || "Patient requested reschedule"
  });

  const { cancelAppointmentReminders, scheduleAppointmentReminders } = require("./reminderService");
  await cancelAppointmentReminders(appointment._id);
  await scheduleAppointmentReminders(appointment);

  await audit({
    actorType: options.staffUser ? "staff" : "patient",
    actorStaff: options.staffUser?._id,
    actorPhone: options.staffUser ? undefined : appointment.phoneE164,
    action: "appointment.rescheduled",
    entityType: "appointment",
    entityId: appointment.appointmentId,
    metadata: { previousDate, previousTime, newDate: date, newTime: normalizedTime },
    req: options.req
  });

  return appointment;
}

async function cancelAppointment({ appointmentId, phone, reason }, options = {}) {
  const appointment = options.staffUser
    ? await Appointment.findOne({ appointmentId })
    : await lookupAppointment({ appointmentId, phone });

  if (!appointment) throw notFound("Appointment was not found.");

  appointment.status = "cancelled";
  appointment.cancelledAt = new Date();
  appointment.reminderStatus = "cancelled";
  await appointment.save();

  const { cancelAppointmentReminders } = require("./reminderService");
  await cancelAppointmentReminders(appointment._id);

  await audit({
    actorType: options.staffUser ? "staff" : "patient",
    actorStaff: options.staffUser?._id,
    actorPhone: options.staffUser ? undefined : appointment.phoneE164,
    action: "appointment.cancelled",
    entityType: "appointment",
    entityId: appointment.appointmentId,
    metadata: { reason },
    req: options.req
  });

  return appointment;
}

async function updateAppointmentStatus(id, status, options = {}) {
  const appointment = await Appointment.findById(id);
  if (!appointment) throw notFound("Appointment was not found.");

  appointment.status = status;
  if (status === "completed") appointment.completedAt = new Date();
  if (status === "arrived") appointment.arrivedAt = new Date();
  if (status === "cancelled") appointment.cancelledAt = new Date();
  
  await appointment.save();

  await audit({
    actorType: "staff",
    actorStaff: options.staffUser?._id,
    action: `appointment.${status}`,
    entityType: "appointment",
    entityId: appointment.appointmentId,
    req: options.req
  });

  return appointment;
}

async function requestEarlierSlot(appointmentId, phone, notes) {
  const appointment = await lookupAppointment({ appointmentId, phone });
  appointment.status = "waiting_for_earlier_slot";
  if (notes) appointment.optionalNote = (appointment.optionalNote ? appointment.optionalNote + " | " : "") + "Earlier slot request: " + notes;
  await appointment.save();
  return appointment;
}

module.exports = {
  createAppointment,
  lookupAppointment,
  listAppointments,
  getAppointmentById,
  rescheduleAppointment,
  cancelAppointment,
  updateAppointmentStatus,
  requestEarlierSlot,
  formatAppointmentId,
  safePublicAppointment
};
