const cron = require("node-cron");
const { Appointment, ReminderJob, ClinicLocation } = require("../models");
const { appointmentDateTime } = require("../utils/time");
const { getClinicSettings } = require("./settingsService");
const { sendAppointmentReminder, sendArrivalUpdate } = require("./appointmentNotificationService");
const { config } = require("../config/env");
const { sendText } = require("./whatsappService");
const { OCCUPYING_APPOINTMENT_STATUSES } = require("../domain/appointmentRules");
const { audit } = require("./auditService");
const { logError } = require("../utils/safeLogger");

const ACTIVE_STATUSES = ["pending", "processing", "queued"];
const MAX_ATTEMPTS = 3;
let schedulerStarted = false;
let schedulerTask;

async function refreshAppointmentReminderStatus(appointmentId) {
  if (!appointmentId) return;
  const jobs = await ReminderJob.find({ appointment: appointmentId, type: "appointment_reminder" }).select("status").lean();
  let reminderStatus = "not_scheduled";
  if (jobs.some((job) => ["pending", "processing"].includes(job.status))) reminderStatus = "pending";
  else if (jobs.some((job) => job.status === "queued")) reminderStatus = "partially_sent";
  else if (jobs.some((job) => job.status === "failed")) reminderStatus = "failed";
  else if (jobs.some((job) => ["sent", "delivered", "read"].includes(job.status))) reminderStatus = "sent";
  else if (jobs.length && jobs.every((job) => job.status === "cancelled")) reminderStatus = "cancelled";
  await Appointment.updateOne({ _id: appointmentId }, { $set: { reminderStatus } });
}

async function scheduleAppointmentReminders(appointment) {
  const settings = await getClinicSettings();
  const scheduleRevision = Number(appointment.rescheduleCount || 0);
  if (!settings.remindersEnabled) {
    await Appointment.updateOne({ _id: appointment._id }, { $set: { reminderStatus: "not_scheduled" } });
    return [];
  }

  const appointmentAt = appointmentDateTime(
    appointment.date,
    appointment.time,
    appointment.slotTimezone || appointment.locationSnapshot?.timezone || settings.timezone
  );
  if (!appointmentAt?.isValid) throw new Error("Appointment reminder time is invalid.");
  const now = new Date();
  const intervals = [...new Set(settings.reminderIntervalsMinutes || [])].sort((a, b) => b - a);
  const scheduled = [];

  for (const intervalMinutes of intervals) {
    const dueAt = appointmentAt.minus({ minutes: intervalMinutes }).toJSDate();
    if (dueAt <= now) continue;
    const job = await ReminderJob.findOneAndUpdate(
      { appointment: appointment._id, type: "appointment_reminder", intervalMinutes, scheduleRevision },
      {
        $setOnInsert: {
          patient: appointment.patient,
          phoneE164: appointment.phoneE164,
          dueAt,
          message: `Appointment reminder for ${appointment.appointmentId}`,
          status: "pending",
          attempts: 0
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    scheduled.push(job);
  }

  if (config.whatsapp.templates.arrivalUpdate) {
    const dueAt = appointmentAt.minus({ minutes: 60 }).toJSDate();
    if (dueAt > now) {
      const arrival = await ReminderJob.findOneAndUpdate(
        { dedupeKey: `arrival:${appointment._id}:${scheduleRevision}` },
        { $setOnInsert: {
          appointment: appointment._id, patient: appointment.patient, phoneE164: appointment.phoneE164,
          type: "arrival_update", dueAt, message: `Arrival update for ${appointment.appointmentId}`,
          status: "pending", attempts: 0, scheduleRevision
        } },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
      );
    }
  }

  await Appointment.updateOne(
    { _id: appointment._id },
    { $set: { reminderStatus: scheduled.length ? "pending" : "not_scheduled" } }
  );
  return scheduled;
}

async function cancelAppointmentReminders(appointmentId) {
  await ReminderJob.updateMany(
    { appointment: appointmentId, status: { $in: ACTIVE_STATUSES } },
    { $set: { status: "cancelled", lastError: "Appointment was cancelled or rescheduled." } }
  );
  await refreshAppointmentReminderStatus(appointmentId);
}

async function claimDueReminder(now = new Date()) {
  return ReminderJob.findOneAndUpdate(
    {
      dueAt: { $lte: now },
      $or: [
        { status: "pending" },
        { status: "processing", lastAttemptAt: { $lte: new Date(now.getTime() - 5 * 60_000) } }
      ]
    },
    {
      $set: { status: "processing", lastAttemptAt: now },
      $inc: { attempts: 1 },
      $unset: { lastError: "", failureCode: "" }
    },
    { new: true, sort: { dueAt: 1 } }
  ).populate("appointment");
}

async function deliverReminder(job) {
  if (job.type === "follow_up_reminder") return sendText(job.phoneE164, job.message);
  if (!job.appointment || !OCCUPYING_APPOINTMENT_STATUSES.includes(job.appointment.status)) {
    return { status: "cancelled", error: "Appointment is no longer active." };
  }
  if (job.type === "arrival_update") {
    const location = await ClinicLocation.findById(job.appointment.location).select("currentDelayMinutes").lean();
    const delayMinutes = Number(location?.currentDelayMinutes || 0);
    const appointmentAt = appointmentDateTime(
      job.appointment.date,
      job.appointment.time,
      job.appointment.slotTimezone || job.appointment.locationSnapshot?.timezone
    );
    const arrivalTime = appointmentAt.minus({ minutes: 15 }).plus({ minutes: delayMinutes }).toFormat("hh:mm a");
    return sendArrivalUpdate(job.appointment, { arrivalTime, delayMinutes });
  }
  return sendAppointmentReminder(job.appointment);
}

async function processDueReminders({ limit = 25 } = {}) {
  const results = [];
  for (let index = 0; index < limit; index += 1) {
    const job = await claimDueReminder();
    if (!job) break;
    try {
      const result = await deliverReminder(job);
      if (result.status === "queued") {
        job.status = "queued";
        job.metaMessageId = result.metaMessageId;
      } else if (result.status === "cancelled") {
        job.status = "cancelled";
        job.lastError = result.error;
      } else {
        job.status = job.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
        job.failureCode = result.failureCode || "REMINDER_SEND_FAILED";
        job.lastError = result.error || "Meta did not accept the reminder.";
      }
      await job.save();
      results.push({ id: job._id, status: job.status });
    } catch (error) {
      job.status = job.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      job.failureCode = "REMINDER_SEND_FAILED";
      job.lastError = String(error.message || "Reminder delivery failed.").slice(0, 500);
      await job.save();
      results.push({ id: job._id, status: job.status });
    }
    await refreshAppointmentReminderStatus(job.appointment?._id || job.appointment);
  }
  return results;
}

async function retryFailedReminder(reminderId, options = {}) {
  const reminder = await ReminderJob.findOneAndUpdate(
    { _id: reminderId, status: "failed" },
    {
      $set: { status: "pending", attempts: 0, dueAt: new Date() },
      $unset: { lastError: "", failureCode: "", metaMessageId: "", sentAt: "" }
    },
    { new: true, runValidators: true }
  );
  if (!reminder) return null;
  await refreshAppointmentReminderStatus(reminder.appointment);
  await audit({
    actorType: "staff",
    actorStaff: options.staffUser?._id,
    action: "reminder.retry_requested",
    entityType: "reminder",
    entityId: String(reminder._id),
    req: options.req
  });
  return reminder;
}

async function recoverMissingReminderSchedules({ limit = 25 } = {}) {
  const appointments = await Appointment.find({
    status: { $in: OCCUPYING_APPOINTMENT_STATUSES },
    reminderStatus: "failed"
  }).sort({ date: 1, time: 1 }).limit(limit);
  let recovered = 0;
  for (const appointment of appointments) {
    const existing = await ReminderJob.exists({ appointment: appointment._id, type: "appointment_reminder" });
    if (existing) continue;
    try {
      await scheduleAppointmentReminders(appointment);
      recovered += 1;
    } catch (error) {
      logError("Reminder schedule recovery failed", error);
    }
  }
  return recovered;
}

function startReminderScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  schedulerTask = cron.schedule("* * * * *", () => {
    recoverMissingReminderSchedules()
      .then(() => processDueReminders())
      .catch((error) => logError("Reminder job failed", error));
  });
}

function stopReminderScheduler() {
  schedulerTask?.stop();
  schedulerTask = undefined;
  schedulerStarted = false;
}

module.exports = {
  ACTIVE_STATUSES,
  scheduleAppointmentReminders,
  cancelAppointmentReminders,
  processDueReminders,
  retryFailedReminder,
  refreshAppointmentReminderStatus,
  recoverMissingReminderSchedules,
  startReminderScheduler,
  stopReminderScheduler
};
