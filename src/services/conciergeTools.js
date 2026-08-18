const { z } = require("zod");
const appointmentService = require("./appointmentService");
const availabilityService = require("./availabilityService");
const locationService = require("./locationService");
const { ConversationSession, Appointment } = require("../models");
const { normalizePhone } = require("../utils/security");
const { badRequest } = require("../utils/errors");
const { OCCUPYING_APPOINTMENT_STATUSES } = require("../domain/appointmentRules");

const schemas = {
  getAvailableSlots: z.object({ locationId: z.string().min(1).max(100), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  createAppointment: z.object({
    confirmed: z.literal(true), fullName: z.string().min(2).max(160), phone: z.string().min(7).max(40),
    age: z.number().int().min(0).max(130).optional(), patientFor: z.enum(["self", "family", "unknown"]).optional(), reason: z.string().min(2).max(1000),
    locationId: z.string().min(1).max(100), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().regex(/^\d{2}:\d{2}$/), consentGiven: z.literal(true), preferredLanguage: z.enum(["en", "ur"]).default("en"),
    idempotencyKey: z.string().min(1).max(300)
  }).strict(),
  verifiedAppointment: z.object({ appointmentId: z.string().min(5).max(60), phone: z.string().min(7).max(40) }).strict(),
  rescheduleAppointment: z.object({ confirmed: z.literal(true), appointmentId: z.string().min(5).max(60), phone: z.string().min(7).max(40), locationId: z.string().min(1).max(100), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/) }).strict(),
  cancelAppointment: z.object({ confirmed: z.literal(true), appointmentId: z.string().min(5).max(60), phone: z.string().min(7).max(40) }).strict(),
  clinicInformation: z.object({ locationId: z.string().min(1).max(100).optional() }).strict(),
  staffHandoff: z.object({ phone: z.string().min(7).max(40), reason: z.string().min(2).max(240) }).strict()
};

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw badRequest("The clinic action request was invalid.");
  return result.data;
}

function createConciergeTools(deps = {}) {
  const appointments = deps.appointmentService || appointmentService;
  const availability = deps.availabilityService || availabilityService;
  const locations = deps.locationService || locationService;
  const Sessions = deps.ConversationSession || ConversationSession;
  const Appointments = deps.Appointment || Appointment;
  return {
    async get_available_slots(input) {
      const value = parse(schemas.getAvailableSlots, input);
      const slots = await availability.getAvailableSlots(value.locationId, value.date);
      return slots.filter((slot) => slot.available).map((slot) => ({ time: slot.time }));
    },
    async create_appointment(input) {
      const value = parse(schemas.createAppointment, input);
      const { idempotencyKey, confirmed, ...appointment } = value;
      return appointments.createAppointment(appointment, { source: "whatsapp", idempotencyKey });
    },
    async lookup_verified_appointment(input) {
      const value = parse(schemas.verifiedAppointment, input);
      return appointments.lookupAppointment({ appointmentId: value.appointmentId, phone: normalizePhone(value.phone) });
    },
    async reschedule_appointment(input) {
      const value = parse(schemas.rescheduleAppointment, input);
      const { confirmed, ...request } = value;
      return appointments.rescheduleAppointment(request, { source: "whatsapp" });
    },
    async cancel_appointment(input) {
      const value = parse(schemas.cancelAppointment, input);
      const { confirmed, ...request } = value;
      return appointments.cancelAppointment({ ...request, reason: "Cancelled by patient through WhatsApp" }, { source: "whatsapp" });
    },
    async get_clinic_information(input = {}) {
      const value = parse(schemas.clinicInformation, input);
      if (value.locationId) return [await locations.getBookableLocation(value.locationId)];
      return locations.listLocations();
    },
    async get_visit_status(input) {
      const value = parse(schemas.verifiedAppointment, input);
      const appointment = await appointments.lookupAppointment({ appointmentId: value.appointmentId, phone: normalizePhone(value.phone) });
      return { appointmentId: appointment.appointmentId, date: appointment.date, time: appointment.time, tokenNumber: appointment.tokenNumber, status: appointment.status };
    },
    async request_staff_handoff(input) {
      const value = parse(schemas.staffHandoff, input);
      return Sessions.findOneAndUpdate(
        { phoneE164: normalizePhone(value.phone) },
        { $set: { aiPaused: true, humanRequired: true, state: "STAFF_HANDOFF", handoffReason: value.reason, lastMessageAt: new Date() } },
        { new: true, upsert: true }
      );
    },
    async active_appointments_for_phone(phone) {
      return Appointments.find({ phoneE164: normalizePhone(phone), status: { $in: OCCUPYING_APPOINTMENT_STATUSES } }).sort({ date: 1, time: 1 }).limit(5);
    }
  };
}

module.exports = { schemas, createConciergeTools };
