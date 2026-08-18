const { config } = require("../config/env");
const { sendTemplate } = require("./whatsappService");

function templateUnavailable(name) {
  return !String(name || "").trim();
}

async function sendAppointmentConfirmation(appointment) {
  const name = config.whatsapp.templates.appointmentConfirmation;
  if (templateUnavailable(name)) return { status: "skipped", failureCode: "TEMPLATE_NOT_CONFIGURED" };
  return sendTemplate(
    appointment.phoneE164,
    name,
    config.whatsapp.templates.appointmentConfirmationLanguage,
    [
      appointment.patientSnapshot.fullName,
      appointment.appointmentId,
      appointment.tokenNumber,
      appointment.date,
      appointment.time,
      appointment.locationSnapshot?.clinicName || "Dr. Sohaib Clinic",
      appointment.locationSnapshot?.address || appointment.locationSnapshot?.city || "Clinic",
      appointment.locationSnapshot?.contactNumber || config.clinicContactNumber || "Clinic contact"
    ],
    { expectedParameterCount: 8 }
  );
}

async function sendRescheduleConfirmation(appointment) {
  const name = config.whatsapp.templates.rescheduleConfirmation;
  if (templateUnavailable(name)) return { status: "skipped", failureCode: "TEMPLATE_NOT_CONFIGURED" };
  return sendTemplate(
    appointment.phoneE164,
    name,
    config.whatsapp.templates.rescheduleConfirmationLanguage,
    [
      appointment.patientSnapshot.fullName,
      appointment.appointmentId,
      appointment.date,
      appointment.time,
      appointment.locationSnapshot?.clinicName || "Dr. Sohaib Clinic",
      appointment.tokenNumber,
      appointment.locationSnapshot?.contactNumber || config.clinicContactNumber || "Clinic contact"
    ],
    { expectedParameterCount: 7 }
  );
}

async function sendCancellationConfirmation(appointment) {
  const name = config.whatsapp.templates.cancellationConfirmation;
  if (templateUnavailable(name)) return { status: "skipped", failureCode: "TEMPLATE_NOT_CONFIGURED" };
  return sendTemplate(
    appointment.phoneE164,
    name,
    config.whatsapp.templates.cancellationConfirmationLanguage,
    [
      appointment.patientSnapshot.fullName,
      appointment.appointmentId,
      appointment.date,
      appointment.time,
      appointment.locationSnapshot?.contactNumber || config.clinicContactNumber || "Clinic contact"
    ],
    { expectedParameterCount: 5 }
  );
}

async function sendAppointmentReminder(appointment) {
  const name = config.whatsapp.templates.appointmentReminder;
  if (templateUnavailable(name)) return { status: "skipped", failureCode: "TEMPLATE_NOT_CONFIGURED" };
  return sendTemplate(
    appointment.phoneE164,
    name,
    config.whatsapp.templates.appointmentReminderLanguage,
    [
      appointment.patientSnapshot.fullName,
      appointment.appointmentId,
      appointment.date,
      appointment.time,
      appointment.locationSnapshot?.contactNumber || config.clinicContactNumber || "Clinic contact",
      "Use Manage Appointment in WhatsApp to reschedule or cancel."
    ],
    { expectedParameterCount: 6 }
  );
}

async function sendArrivalUpdate(appointment, { arrivalTime, delayMinutes = 0 } = {}) {
  const name = config.whatsapp.templates.arrivalUpdate;
  if (templateUnavailable(name)) return { status: "skipped", failureCode: "TEMPLATE_NOT_CONFIGURED" };
  const delayMessage = delayMinutes > 0
    ? `Dr. Sohaib is approximately ${delayMinutes} minutes behind schedule.`
    : "No clinic delay has been reported.";
  return sendTemplate(
    appointment.phoneE164,
    name,
    config.whatsapp.templates.arrivalUpdateLanguage,
    [
      appointment.patientSnapshot.fullName,
      appointment.appointmentId,
      appointment.time,
      arrivalTime,
      delayMessage,
      appointment.locationSnapshot?.clinicName || "Dr. Sohaib Clinic",
      appointment.locationSnapshot?.address || appointment.locationSnapshot?.city || "Clinic"
    ],
    { expectedParameterCount: 7 }
  );
}

module.exports = {
  sendAppointmentConfirmation,
  sendRescheduleConfirmation,
  sendCancellationConfirmation,
  sendAppointmentReminder,
  sendArrivalUpdate
};
