const { ClinicLocation, Appointment } = require("../models");
const { OCCUPYING_APPOINTMENT_STATUSES } = require("../domain/appointmentRules");
const { validateSlotAgainstSchedule, appointmentDateTime, nowInClinicZone } = require("../utils/time");
const { badRequest, conflict, notFound } = require("../utils/errors");

const SCHEDULE_FIELDS = Object.freeze([
  "status", "timezone", "weeklyHours", "slotDurationMinutes", "sameDayBookingCutoffMinutes"
]);

async function findConflictingAppointments(location, candidate) {
  const today = nowInClinicZone(candidate.timezone).toISODate();
  const appointments = await Appointment.find({
    location: location._id,
    date: { $gte: today },
    status: { $in: OCCUPYING_APPOINTMENT_STATUSES }
  }).select("appointmentId date time").lean();
  if (candidate.status !== "Active") return appointments;
  const scheduleOnly = { ...candidate, sameDayBookingCutoffMinutes: 0 };
  return appointments.filter((appointment) => {
    const slot = appointmentDateTime(appointment.date, appointment.time, candidate.timezone);
    return !validateSlotAgainstSchedule({ settings: scheduleOnly, date: appointment.date, time: appointment.time, now: slot.minus({ minutes: 1 }) }).ok;
  });
}

async function updateLocation(locationId, input, { confirmExistingAppointments = false, staffUser } = {}) {
  const location = await ClinicLocation.findById(locationId);
  if (!location) throw notFound("Clinic location was not found.");
  const update = { ...input };
  delete update.confirmExistingAppointments;
  const candidate = { ...location.toObject(), ...update };
  const validationDocument = new ClinicLocation(candidate);
  validationDocument._id = location._id;
  try { await validationDocument.validate(); }
  catch { throw badRequest("The clinic schedule contains invalid or conflicting values."); }

  const scheduleChanged = SCHEDULE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(update, field));
  let conflicts = [];
  if (scheduleChanged) conflicts = await findConflictingAppointments(location, candidate);
  if (conflicts.length && !confirmExistingAppointments) {
    throw conflict("The schedule change conflicts with existing appointments. Confirm explicitly to preserve those appointments and apply the schedule.", {
      requiresConfirmation: true,
      appointmentCount: conflicts.length,
      appointmentIds: conflicts.slice(0, 20).map((appointment) => appointment.appointmentId)
    });
  }

  Object.assign(location, update);
  if (Object.prototype.hasOwnProperty.call(update, "currentDelayMinutes")) {
    location.delayUpdatedAt = new Date();
    location.delayUpdatedBy = staffUser?._id;
  }
  await location.save();
  return { location, conflictingAppointmentsPreserved: conflicts.length };
}

module.exports = { SCHEDULE_FIELDS, findConflictingAppointments, updateLocation };
