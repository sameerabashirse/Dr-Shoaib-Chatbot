const { DateTime } = require("luxon");
const models = require("../models");
const { config } = require("../config/env");
const { normalizePhone } = require("../utils/security");
const { normalizeTime } = require("../utils/time");
const { createConciergeTools } = require("../services/conciergeTools");
const { understandPatientMessage, emergencyPattern, unsafeMedicalPattern } = require("../services/conciergeUnderstandingService");
const { sendMediaById } = require("../services/whatsappService");

const reply = {
  text: (body) => ({ kind: "text", body }),
  buttons: (body, buttons) => ({ kind: "buttons", body, buttons })
};

function language(value) { return value === "ur" ? "ur" : value === "roman_ur" ? "roman_ur" : "en"; }

function resolveDate(value, timezone = config.clinicTimezone) {
  const input = String(value || "").trim().toLowerCase();
  const today = DateTime.now().setZone(timezone).startOf("day");
  const iso = DateTime.fromISO(input, { zone: timezone });
  if (/^\d{4}-\d{2}-\d{2}$/.test(input) && iso.isValid && iso >= today) return iso.toISODate();
  if (/^(today|aaj|aj)$/.test(input)) return today.toISODate();
  if (/^(tomorrow|kal)$/.test(input)) return today.plus({ days: 1 }).toISODate();
  const weekdays = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };
  if (weekdays[input]) {
    let date = today;
    while (date.weekday !== weekdays[input]) date = date.plus({ days: 1 });
    return date.toISODate();
  }
  return "";
}

function mergeFacts(context, facts) {
  const next = { ...context };
  const fields = { patientName: "fullName", age: "age", concern: "reason", clinic: "clinic", preferredDate: "preferredDate", preferredTime: "preferredTime", appointmentId: "appointmentId", reportsAvailable: "reportsAvailable", patientFor: "patientFor" };
  for (const [source, target] of Object.entries(fields)) {
    if (facts[source] !== null && facts[source] !== undefined && facts[source] !== "unknown") next[target] = facts[source];
  }
  next.language = language(facts.language || next.language);
  return next;
}

function visitSummary(context) {
  const age = Number.isInteger(context.age) ? `, ${context.age}` : "";
  return `Visit Summary\nPatient: ${context.fullName}${age}\nConcern: ${context.reason}\nReports: ${context.wantsReports ? "To be attached after confirmation" : "None shared"}\nAppointment: ${context.date}, ${context.time}\nClinic: ${context.locationName}\n\nPatient-provided information only — not an AI diagnosis.`;
}

function createConversationOrchestrator(deps = {}) {
  const d = { models: deps.models || models, tools: deps.tools || createConciergeTools(deps), understand: deps.understand || understandPatientMessage, sendMedia: deps.sendMedia || sendMediaById };
  async function save(session, state, context = session.context || {}) { session.state = state; session.context = context; session.lastMessageAt = new Date(); await session.save(); }
  async function handoff(session, phone, reason) {
    await d.tools.request_staff_handoff({ phone, reason });
    session.aiPaused = true; session.humanRequired = true;
    await save(session, "STAFF_HANDOFF", session.context || {});
    return reply.text("I’m connecting you with the clinic receptionist for accurate assistance.");
  }
  async function clinicInformation() {
    const locations = await d.tools.get_clinic_information({});
    return reply.text(locations.map((item) => `${item.clinicName}, ${item.city}\n${item.fullAddress || "Address available from reception"}`).join("\n\n"));
  }
  async function chooseClinic(session, context) {
    const locations = await d.tools.get_clinic_information({});
    const active = locations.filter((item) => item.status === "Active" || item.status === "active" || (item.isActive && item.bookingEnabled));
    const wanted = String(context.clinic || "").toLowerCase();
    const selected = wanted
      ? active.find((item) => [item.code, item.city, item.clinicName].some((value) => String(value || "").toLowerCase().includes(wanted)))
      : active.length === 1 ? active[0] : null;
    if (selected) return { ...context, locationId: String(selected._id || selected.code), locationName: `${selected.clinicName}, ${selected.city}` };
    if (!active.length) return null;
    await save(session, "BOOKING_CLINIC", context);
    return reply.buttons("Which clinic would you prefer?", active.slice(0, 3).map((item) => ({ id: `AI_CLINIC_${item.code}`, title: String(item.city).slice(0, 20) })));
  }
  async function continueBooking(session, phone, context, messageId) {
    let next = { ...context, phone };
    if (!next.fullName) { await save(session, "BOOKING_NAME", next); return reply.text("What is the patient’s full name?"); }
    if (!next.reason) { await save(session, "BOOKING_CONCERN", next); return reply.text("Briefly, what would you like Dr. Sohaib to check?"); }
    const clinic = await chooseClinic(session, next);
    if (!clinic) return handoff(session, phone, "No bookable clinic available");
    if (clinic.body) return clinic;
    next = clinic;
    next.date = resolveDate(next.preferredDate || next.date);
    if (!next.date) { await save(session, "BOOKING_DATE", next); return reply.text("Which day would you prefer?"); }
    const slots = await d.tools.get_available_slots({ locationId: next.locationId, date: next.date });
    if (!slots.length) { delete next.date; delete next.preferredDate; await save(session, "BOOKING_DATE", next); return reply.text("That day has no available appointment. Which other day would suit you?"); }
    const wantedTime = normalizeTime(next.preferredTime || next.time);
    if (wantedTime && slots.some((slot) => slot.time === wantedTime)) return askReports(session, { ...next, time: wantedTime });
    await save(session, "BOOKING_TIME", { ...next, availableTimes: slots.slice(0, 3).map((slot) => slot.time), messageId });
    return reply.buttons(`I found these available times on ${next.date}. Which suits you?`, slots.slice(0, 3).map((slot) => ({ id: `AI_TIME_${slot.time}`, title: slot.time })));
  }
  async function askReports(session, context) {
    await save(session, "BOOKING_REPORTS", context);
    return reply.buttons("Would you like to attach previous PDF, JPEG, or PNG medical reports for Dr. Sohaib?", [
      { id: "AI_REPORTS_YES", title: "Upload Reports" }, { id: "AI_REPORTS_NO", title: "Continue Without" }
    ]);
  }
  async function findActiveClinic() {
    const locations = await d.tools.get_clinic_information({});
    return locations.find((item) => item.status === "Active" || item.status === "active" || (item.isActive && item.bookingEnabled));
  }

  return async function handle({ phoneE164, text = "", language: requestedLanguage = "en", replyId = "", messageId = "", source = "text" }) {
    const phone = normalizePhone(phoneE164) || phoneE164;
    let session = await d.models.ConversationSession.findOne({ phoneE164: phone });
    if (!session) session = await d.models.ConversationSession.create({ phoneE164: phone, language: requestedLanguage === "ur" ? "ur" : "en", state: "IDLE", context: {}, lastMessageAt: new Date() });
    if (session.aiPaused) return reply.text("The clinic receptionist is assisting you. Automated replies will resume when staff returns the conversation.");
    const input = String(text || "").trim();
    const action = String(replyId || input).trim();
    const upper = action.toUpperCase();
    const facts = await d.understand(input || action, { context: session.context || {}, phone });
    const lang = language(facts.language || session.context?.language || requestedLanguage);
    session.lastAiIntent = facts.intent; session.lastAiConfidence = facts.confidence;

    if (emergencyPattern.test(input) || facts.intent === "emergency") {
      await save(session, "EMERGENCY_STOP", { language: lang });
      if (d.models.EmergencyAlert) {
        await d.models.EmergencyAlert.create({
          phoneE164: phone,
          conversation: session._id,
          alertMessage: "Emergency language detected; automated clinical conversation stopped.",
          priority: "critical",
          status: "open"
        });
      }
      return reply.text(config.aiConcierge.emergencyMessage);
    }
    if (unsafeMedicalPattern.test(input)) return handoff(session, phone, "Medical advice or report interpretation request");
    const greetingOnly = /^(hi|hello|hey|salam|assalam(?:-o-alaikum)?|aoa|start)[!.\s]*$/i.test(input);
    if (greetingOnly || (facts.intent === "greeting" && input.split(/\s+/).length <= 3)) {
      await save(session, "IDLE", { language: lang });
      return reply.text("Assalam-o-Alaikum! I’m Dr. Sohaib’s Smart Clinic Assistant.\nYou can type or send a voice note and tell me how I can help.");
    }
    if (facts.intent === "staff_handoff") return handoff(session, phone, "Patient requested a person");
    if (facts.intent === "clinic_info" || upper === "AI_DIRECTIONS") return clinicInformation();
    if (upper === "AI_TALK_RECEPTION") return handoff(session, phone, "Patient requested reception after booking");
    if (upper === "AI_REPORTS_ADD" && session.state === "AWAITING_REPORT") return reply.text("Please attach the next PDF, JPEG, or PNG report.");
    if (upper === "AI_REPORTS_DONE" && session.state === "AWAITING_REPORT") { await save(session, "IDLE", { language: lang, appointmentId: session.context.appointmentId }); return reply.text("Thank you. Your reports are securely linked to the appointment."); }

    if (upper.startsWith("AI_CLINIC_") && session.state === "BOOKING_CLINIC") {
      const locations = await d.tools.get_clinic_information({});
      const selected = locations.find((item) => item.code === action.slice("AI_CLINIC_".length));
      if (!selected) return reply.text("That clinic is unavailable. Please tell me which clinic you prefer.");
      return continueBooking(session, phone, { ...session.context, locationId: String(selected._id || selected.code), locationName: `${selected.clinicName}, ${selected.city}` }, messageId);
    }
    if (upper.startsWith("AI_TIME_") && session.state === "BOOKING_TIME") {
      const time = action.slice("AI_TIME_".length);
      if (!(session.context.availableTimes || []).includes(time)) return reply.text("Please choose one of the displayed times.");
      const context = { ...session.context, time }; delete context.availableTimes;
      return askReports(session, context);
    }
    if (["AI_REPORTS_YES", "AI_REPORTS_NO"].includes(upper) && session.state === "BOOKING_REPORTS") {
      const context = { ...session.context, wantsReports: upper === "AI_REPORTS_YES", summarySource: source === "voice" ? "whatsapp_voice" : "whatsapp_text" };
      await save(session, "BOOKING_SUMMARY", context);
      return reply.buttons(`${visitSummary(context)}\n\nIs everything correct?`, [{ id: "AI_SUMMARY_OK", title: "Everything Is Correct" }, { id: "AI_SUMMARY_CHANGE", title: "Make a Change" }]);
    }
    if (upper === "AI_SUMMARY_CHANGE" && session.state === "BOOKING_SUMMARY") { await save(session, "BOOKING_CHANGE", session.context); return reply.text("Tell me the detail you would like to change."); }
    if (upper === "AI_SUMMARY_OK" && session.state === "BOOKING_SUMMARY") {
      await save(session, "BOOKING_CONSENT", { ...session.context, summaryApprovedAt: new Date().toISOString() });
      return reply.buttons(`${config.appointmentConsent.text}\n\nDo you consent?`, [{ id: "AI_CONSENT_YES", title: "Yes, I Consent" }, { id: "AI_CONSENT_NO", title: "No" }]);
    }
    if (upper === "AI_CONSENT_NO" && session.state === "BOOKING_CONSENT") { await save(session, "IDLE", { language: lang }); return reply.text("No appointment was created because consent was not provided."); }
    if (upper === "AI_CONSENT_YES" && session.state === "BOOKING_CONSENT") {
      await save(session, "BOOKING_CONFIRM", { ...session.context, consentGiven: true });
      return reply.buttons(`Please confirm ${session.context.fullName} on ${session.context.date} at ${session.context.time}, ${session.context.locationName}.`, [{ id: "AI_BOOK_CONFIRM", title: "Confirm Appointment" }, { id: "AI_BOOK_TIME", title: "Change Time" }]);
    }
    if (upper === "AI_BOOK_TIME" && session.state === "BOOKING_CONFIRM") { const context = { ...session.context }; delete context.time; delete context.preferredTime; return continueBooking(session, phone, context, messageId); }
    if (upper === "AI_BOOK_CONFIRM" && session.state === "BOOKING_CONFIRM") {
      const context = session.context;
      try {
        const appointment = await d.tools.create_appointment({ confirmed: true, fullName: context.fullName, phone, ...(Number.isInteger(context.age) ? { age: context.age } : {}), patientFor: context.patientFor || "unknown", reason: context.reason, locationId: context.locationId, date: context.date, time: context.time, consentGiven: true, preferredLanguage: lang === "ur" ? "ur" : "en", idempotencyKey: messageId || `wa:${phone}:${context.date}:${context.time}` });
        appointment.patientProvidedVisitSummary = { patientName: context.fullName, ...(Number.isInteger(context.age) ? { age: context.age } : {}), concern: context.reason, reportsAttached: 0, disclaimer: "Patient-provided information only — not an AI diagnosis.", approvedAt: new Date(context.summaryApprovedAt), source: context.summarySource || "whatsapp_text" };
        await appointment.save();
        if (config.aiConcierge.doctorWelcomeMediaId && d.models.Appointment?.countDocuments) {
          const patientAppointments = await d.models.Appointment.countDocuments({ patient: appointment.patient });
          if (patientAppointments === 1) {
            const mediaType = config.aiConcierge.doctorWelcomeMediaId.startsWith("video:") ? "video" : "audio";
            const mediaId = config.aiConcierge.doctorWelcomeMediaId.replace(/^(?:audio|video):/, "");
            const sent = await d.sendMedia(phone, mediaType, mediaId, "Welcome from Dr. Sohaib").catch(() => null);
            if (["accepted", "queued", "sent"].includes(sent?.status)) { appointment.doctorWelcomeSentAt = new Date(); await appointment.save(); }
          }
        }
        await save(session, context.wantsReports ? "AWAITING_REPORT" : "IDLE", { language: lang, appointmentId: appointment.appointmentId, wantsReports: context.wantsReports });
        return reply.buttons(`✅ Appointment Confirmed\n${context.fullName}\n${context.date}, ${context.time}\nToken: ${appointment.tokenNumber}\n${context.locationName}\nReports received: 0${context.wantsReports ? "\n\nPlease attach the report now as a PDF, JPEG, or PNG." : ""}`, [{ id: "AI_DIRECTIONS", title: "Directions" }, { id: "AI_CHANGE_APPOINTMENT", title: "Change Appointment" }, { id: "AI_TALK_RECEPTION", title: "Talk to Reception" }]);
      } catch (error) { return reply.text(error?.statusCode ? `${error.message} Please choose another time.` : "I couldn’t complete the appointment safely. Please talk to reception."); }
    }

    if (session.state === "BOOKING_CONSENT") {
      return reply.buttons("Your active consent is required before an appointment can be created.", [
        { id: "AI_CONSENT_YES", title: "Yes, I Consent" }, { id: "AI_CONSENT_NO", title: "No" }
      ]);
    }
    if (session.state === "BOOKING_CONFIRM") {
      return reply.buttons("Please explicitly confirm the appointment or choose another time.", [
        { id: "AI_BOOK_CONFIRM", title: "Confirm Appointment" }, { id: "AI_BOOK_TIME", title: "Change Time" }
      ]);
    }

    if (upper === "AI_CHANGE_APPOINTMENT") { await save(session, "RESCHEDULE_ID", { language: lang }); return reply.text("Please send the appointment ID from your confirmation."); }
    if (upper === "AI_CANCEL_KEEP" && session.state === "CANCEL_CONFIRM") { await save(session, "IDLE", { language: lang }); return reply.text("Your appointment was kept unchanged."); }
    if (upper === "AI_CANCEL_CONFIRM" && session.state === "CANCEL_CONFIRM") {
      const appointment = await d.tools.cancel_appointment({ confirmed: true, appointmentId: session.context.appointmentId, phone });
      await save(session, "IDLE", { language: lang }); return reply.text(`Appointment ${appointment.appointmentId} has been cancelled.`);
    }
    if (facts.intent === "cancel" || session.state === "CANCEL_ID") {
      const appointmentId = facts.appointmentId || (session.state === "CANCEL_ID" ? input.toUpperCase() : null);
      if (!appointmentId) { await save(session, "CANCEL_ID", { language: lang }); return reply.text("Please send the appointment ID you want to cancel."); }
      try { await d.tools.lookup_verified_appointment({ appointmentId, phone }); }
      catch { return reply.text("I couldn’t verify that appointment with this WhatsApp number. Please check the ID or talk to reception."); }
      await save(session, "CANCEL_CONFIRM", { language: lang, appointmentId });
      return reply.buttons(`Cancel appointment ${appointmentId}?`, [{ id: "AI_CANCEL_CONFIRM", title: "Confirm Cancellation" }, { id: "AI_CANCEL_KEEP", title: "Keep Appointment" }]);
    }

    if (upper.startsWith("AI_RESCHEDULE_TIME_") && session.state === "RESCHEDULE_TIME") {
      const time = action.slice("AI_RESCHEDULE_TIME_".length);
      if (!(session.context.availableTimes || []).includes(time)) return reply.text("Please choose one of the offered times.");
      const context = { ...session.context, time }; delete context.availableTimes; await save(session, "RESCHEDULE_CONFIRM", context);
      return reply.buttons(`Move ${context.appointmentId} to ${context.date} at ${time}?`, [{ id: "AI_RESCHEDULE_CONFIRM", title: "Confirm Change" }, { id: "AI_RESCHEDULE_STOP", title: "Keep Current" }]);
    }
    if (upper === "AI_RESCHEDULE_STOP" && session.state === "RESCHEDULE_CONFIRM") { await save(session, "IDLE", { language: lang }); return reply.text("Your current appointment was kept unchanged."); }
    if (upper === "AI_RESCHEDULE_CONFIRM" && session.state === "RESCHEDULE_CONFIRM") {
      const context = session.context;
      const appointment = await d.tools.reschedule_appointment({ confirmed: true, appointmentId: context.appointmentId, phone, locationId: context.locationId, date: context.date, time: context.time });
      await save(session, "IDLE", { language: lang }); return reply.text(`Appointment ${appointment.appointmentId} is now scheduled for ${appointment.date} at ${appointment.time}.`);
    }
    if (facts.intent === "reschedule" || session.state.startsWith("RESCHEDULE_")) {
      let context = mergeFacts(session.context || {}, facts);
      if (session.state === "RESCHEDULE_ID" && !context.appointmentId) context.appointmentId = input.toUpperCase();
      if (!context.appointmentId) { await save(session, "RESCHEDULE_ID", context); return reply.text("Please send the appointment ID you want to change."); }
      try { await d.tools.lookup_verified_appointment({ appointmentId: context.appointmentId, phone }); }
      catch { return reply.text("I couldn’t verify that appointment with this WhatsApp number. Please check the ID or talk to reception."); }
      context.date = resolveDate(context.preferredDate || context.date);
      if (!context.date) { await save(session, "RESCHEDULE_DATE", context); return reply.text("Which new day would you prefer?"); }
      const location = await findActiveClinic();
      if (!location) return handoff(session, phone, "No clinic available for rescheduling");
      context.locationId = String(location._id || location.code); context.locationName = `${location.clinicName}, ${location.city}`;
      const slots = await d.tools.get_available_slots({ locationId: context.locationId, date: context.date });
      const wanted = normalizeTime(context.preferredTime || context.time);
      if (!wanted || !slots.some((slot) => slot.time === wanted)) {
        await save(session, "RESCHEDULE_TIME", { ...context, availableTimes: slots.slice(0, 3).map((slot) => slot.time) });
        if (!slots.length) return reply.text("No time is available on that day. Which other day would suit you?");
        return reply.buttons("Which new time suits you?", slots.slice(0, 3).map((slot) => ({ id: `AI_RESCHEDULE_TIME_${slot.time}`, title: slot.time })));
      }
      context.time = wanted; await save(session, "RESCHEDULE_CONFIRM", context);
      return reply.buttons(`Move ${context.appointmentId} to ${context.date} at ${context.time}?`, [{ id: "AI_RESCHEDULE_CONFIRM", title: "Confirm Change" }, { id: "AI_RESCHEDULE_STOP", title: "Keep Current" }]);
    }

    if (session.state === "STATUS_ID" || facts.intent === "visit_status" || facts.intent === "lookup") {
      const appointmentId = facts.appointmentId || (session.state === "STATUS_ID" ? input.toUpperCase() : null);
      if (!appointmentId) { await save(session, "STATUS_ID", { language: lang }); return reply.text("Please send your appointment ID so I can verify it."); }
      try { const status = await d.tools.get_visit_status({ appointmentId, phone }); await save(session, "IDLE", { language: lang }); return reply.text(`Appointment ${status.appointmentId}\n${status.date}, ${status.time}\nToken: ${status.tokenNumber}\nStatus: ${status.status}`); }
      catch { return reply.text("I couldn’t verify that appointment with this WhatsApp number."); }
    }

    const bookingState = session.state.startsWith("BOOKING_");
    if (facts.intent === "book" || bookingState) {
      let context = mergeFacts(session.context || { language: lang }, facts);
      if (session.state === "BOOKING_CHANGE") {
        const changedDate = resolveDate(facts.preferredDate || "");
        if (changedDate) { context.date = changedDate; context.preferredDate = changedDate; delete context.time; delete context.preferredTime; }
        if (facts.preferredTime) { context.preferredTime = facts.preferredTime; delete context.time; }
        if (facts.patientName) context.fullName = facts.patientName;
        if (Number.isInteger(facts.age)) context.age = facts.age;
        if (facts.concern) context.reason = facts.concern;
        if (!facts.patientName && !Number.isInteger(facts.age) && !facts.concern && !changedDate && !facts.preferredTime) {
          const name = input.match(/(?:name\s+(?:is|should be)|naam\s+)([\p{L}][\p{L} .'-]{1,80})/iu);
          const age = input.match(/(?:age|umar)\s*(?:is|hai|=|:)?\s*(\d{1,3})/i);
          if (name) context.fullName = name[1].trim();
          if (age && Number(age[1]) <= 130) context.age = Number(age[1]);
        }
      }
      if (session.state === "BOOKING_NAME" && !context.fullName && input.length >= 2) context.fullName = input.slice(0, 160);
      if (session.state === "BOOKING_CONCERN" && !context.reason && input.length >= 2) context.reason = input.slice(0, 500);
      if (session.state === "BOOKING_DATE" && !context.preferredDate) context.preferredDate = input;
      return continueBooking(session, phone, context, messageId);
    }
    if (facts.confidence < 0.45) return handoff(session, phone, "Low-confidence patient request");
    return reply.text("Please tell me in one message if you need an appointment, want to change or cancel one, need the clinic location, or want reception staff.");
  };
}

module.exports = { createConversationOrchestrator, handleIncomingMessage: createConversationOrchestrator(), resolveDate, mergeFacts, visitSummary };
