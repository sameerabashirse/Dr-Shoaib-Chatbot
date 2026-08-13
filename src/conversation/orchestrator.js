const models = require("../models");
const appointmentService = require("../services/appointmentService");
const availabilityService = require("../services/availabilityService");
const locationService = require("../services/locationService");
const { normalizePhone } = require("../utils/security");
const { tr } = require("./translations");
const msg = require("./messages");

const ACTIVE_STATUSES = ["pending", "scheduled", "confirmed", "patient_confirmed", "arrived", "in_consultation", "rescheduled", "waiting_for_earlier_slot"];
const CONSENT_TEXT = "The clinic will use your information for appointment management, reminders, rescheduling, and clinic communications.";

const consultationReasons = [
  "General Consultation",
  "Joint & Bone Pain",
  "Knee Joint Assessment",
  "Back / Spine Pain",
  "Shoulder Stiffness & Pain",
  "Sports Injury & Ligament Strain",
  "Trauma / Fracture Check",
  "Post-Operation Follow-up",
  "Medical Report Review",
  "Prefer not to say"
];

const departmentIcons = ["🩺", "🦴", "🦵", "🧍", "💪", "🏃", "🩹", "🔄", "📄", "🔒"];

function createConversationOrchestrator(deps = {}) {
  const d = { models, appointmentService, availabilityService, locationService, ...deps };

  async function save(session, state, context = session.context || {}) {
    session.state = state;
    session.context = context;
    session.lastMessageAt = new Date();
    await session.save();
  }

  async function activeAppointmentsFor(phone) {
    return d.models.Appointment.find({ phoneE164: phone, status: { $in: ACTIVE_STATUSES } }).sort({ date: 1, time: 1 });
  }

  function withNavigation(rows) {
    return [...rows, { id: "MENU_MAIN", title: "Main Menu" }];
  }

  async function locationMenu(session, mode = "booking") {
    const locations = await d.locationService.listLocations({ bookableOnly: true });
    if (!locations.length) return { body: "No clinic is currently accepting appointments. Please contact clinic staff." };
    await save(session, mode === "booking" ? "BOOKING_LOCATION" : "RESCHEDULE_LOCATION", session.context || {});
    return msg.list(
      mode === "booking" ? "Select an active clinic for your appointment." : "Select the clinic for the rescheduled appointment.",
      withNavigation(locations.slice(0, 9).map((location) => ({
        id: `${mode === "booking" ? "BOOK_LOCATION" : "RESCHEDULE_LOCATION"}_${location.code}`,
        title: `📍 ${location.city}`.slice(0, 24),
        description: location.clinicName.slice(0, 72)
      }))),
      "📍 Select District"
    );
  }

  async function dateMenu(session, mode, offset = 0) {
    const context = session.context || {};
    const dates = await d.availabilityService.getAvailableDates(context.locationId, 60);
    if (!dates.length) return { body: "No appointment dates are currently available for this clinic. Type BACK or MENU." };
    const page = dates.slice(offset, offset + 8);
    const prefix = mode === "booking" ? "BOOK" : "RESCHEDULE";
    const rows = page.map((entry) => ({
      id: `${prefix}_DATE_${entry.date}`,
      title: `📅 ${entry.date}`,
      description: `${entry.availableSlots} available slot${entry.availableSlots === 1 ? "" : "s"}`
    }));
    if (dates.length > offset + 8) rows.push({ id: `${prefix}_DATES_MORE_${offset + 8}`, title: "More dates" });
    rows.push({ id: "BACK", title: "Back" });
    await save(session, mode === "booking" ? "BOOKING_DATE" : "RESCHEDULE_DATE", context);
    return msg.list("Choose an available appointment date.", rows, "📅 Select Date");
  }

  async function slotMenu(session, mode, offset = 0) {
    const context = session.context || {};
    const slots = await d.availabilityService.getAvailableSlots(context.locationId, context.date);
    const available = slots.filter((slot) => slot.available);
    if (!available.length) return { body: "That date no longer has an available slot. Type BACK to select another date." };
    const page = available.slice(offset, offset + 8);
    const prefix = mode === "booking" ? "BOOK" : "RESCHEDULE";
    const rows = page.map((slot) => ({ id: `${prefix}_SLOT_${slot.time}`, title: `🕒 ${slot.time}`, description: "Available appointment" }));
    if (available.length > offset + 8) rows.push({ id: `${prefix}_SLOTS_MORE_${offset + 8}`, title: "More times" });
    rows.push({ id: "BACK", title: "Back" });
    await save(session, mode === "booking" ? "BOOKING_TIME" : "RESCHEDULE_TIME", context);
    return msg.list("Choose an available appointment time.", rows, "🕒 Select Time");
  }

  function appointmentSummary(appointment) {
    return `Appointment ID: ${appointment.appointmentId}\nToken: ${appointment.tokenNumber}\nDate: ${appointment.date}\nTime: ${appointment.time}\nStatus: ${appointment.status}\nLocation: ${appointment.locationSnapshot?.clinicName || "Dr. Sohaib Clinic"}, ${appointment.locationSnapshot?.city || ""}`;
  }

  function maskedPhone(phone) {
    const value = String(phone || "");
    return value.length > 7 ? `${value.slice(0, 4)}****${value.slice(-3)}` : "your WhatsApp number";
  }

  async function manageAppointment(session, phone, appointment) {
    let selected = appointment;
    if (!selected) {
      const appointments = await activeAppointmentsFor(phone);
      if (!appointments.length) {
        await save(session, "LOOKUP_ID", {});
        return { body: `${tr(session.language, "noAppointment")}\n\nEnter your appointment ID to look up another appointment, or type MENU.` };
      }
      selected = appointments[0];
    }
    await save(session, "MANAGE_APPOINTMENT", { appointmentId: selected.appointmentId });
    return msg.list(
      `Dr. Sohaib appointment:\n\n${appointmentSummary(selected)}`,
      [
        { id: `MANAGE_CANCEL_${selected.appointmentId}`, title: "Cancel Appointment" },
        { id: `MANAGE_RESCHEDULE_${selected.appointmentId}`, title: "Reschedule" },
        { id: "MANAGE_LOOKUP", title: "Lookup by ID" },
        { id: "MENU_MAIN", title: "Main Menu" }
      ],
      "Appointment options"
    );
  }

  async function bookingReview(session) {
    const context = session.context || {};
    await save(session, "BOOKING_REVIEW", context);
    return msg.buttons(
      `Review your appointment:\n\nDistrict: ${context.district}\nPatient: ${context.fullName}\nPhone: ${maskedPhone(context.bookingPhone)}\nDepartment: ${context.department || context.reason}\nClinic: ${context.locationName}\nDate: ${context.date}\nTime: ${context.time}\nConsent: Yes\n\nConfirm these details?`,
      [
        { id: "CONFIRM_BOOKING", title: "✅ Confirm Booking" },
        { id: "BACK", title: "⬅️ Back" },
        { id: "MENU_MAIN", title: "🏠 Main Menu" }
      ]
    );
  }

  async function rescheduleReview(session) {
    const context = session.context || {};
    await save(session, "RESCHEDULE_REVIEW", context);
    return msg.buttons(
      `Review the new appointment details:\n\nAppointment ID: ${context.appointmentId}\nClinic: ${context.locationName}\nDate: ${context.date}\nTime: ${context.time}\n\nConfirm rescheduling?`,
      [
        { id: "CONFIRM_RESCHEDULE", title: "Confirm" },
        { id: "BACK", title: "Back" },
        { id: "MENU_MAIN", title: "Main Menu" }
      ]
    );
  }

  return async function handle({ phoneE164, text = "", language = "en", replyId = "" }) {
    const phone = normalizePhone(phoneE164) || phoneE164;
    let session = await d.models.ConversationSession.findOne({ phoneE164: phone });
    if (!session) {
      session = await d.models.ConversationSession.create({
        phoneE164: phone, language: language || "en", state: "MAIN_MENU", lastMessageAt: new Date()
      });
    }

    const input = String(text || "").trim();
    const action = String(replyId || input).trim();
    const upperAction = action.toUpperCase();
    const lang = session.language || "en";

    if (/^(HI|HELLO|HEY|MENU|START)$/i.test(input) || upperAction === "MENU_MAIN") {
      session.aiPaused = false;
      session.humanRequired = false;
      await save(session, "MAIN_MENU", {});
      return msg.mainMenu(lang);
    }
    if (upperAction === "LANG_EN" || upperAction === "LANG_UR") {
      session.language = upperAction === "LANG_UR" ? "ur" : "en";
      await save(session, "MAIN_MENU", {});
      return msg.mainMenu(session.language);
    }
    if (upperAction === "BACK") {
      await save(session, "MAIN_MENU", {});
      return msg.mainMenu(lang);
    }
    if (session.aiPaused) return { body: "You are currently connected with Dr. Sohaib's clinic staff. Type MENU to return to the automated assistant." };

    if (/\b(emergency|urgent|accident|severe pain|bleeding|injury)\b/i.test(input)) {
      await d.models.EmergencyAlert.create({
        phoneE164: phone, patient: session.patient || null, conversation: session._id,
        alertMessage: input, priority: "critical", status: "open"
      });
      const hotline = require("../config/env").config.clinicContactNumber;
      return { body: `${tr(lang, "emergency")}${hotline ? `\n\nClinic Hotline: ${hotline}` : ""}` };
    }

    if (upperAction === "MENU_BOOK" || (session.state === "MAIN_MENU" && /^(book|book appointment)$/i.test(input))) return locationMenu(session, "booking");
    if (upperAction === "MENU_MANAGE" || (session.state === "MAIN_MENU" && /^(manage|manage appointment)$/i.test(input))) return manageAppointment(session, phone);
    if (upperAction === "MENU_UPLOAD" || (session.state === "MAIN_MENU" && /^(upload|upload document|medical document|report)$/i.test(input))) {
      return msg.buttons(
        "📎 To protect your medical information, document upload is currently handled by authorized clinic staff. Please choose Speak to Staff; do not send a medical document in this chat until staff confirms the secure method.",
        [{ id: "MENU_STAFF", title: "💬 Speak to Staff" }, { id: "MENU_MAIN", title: "🏠 Main Menu" }]
      );
    }
    if (upperAction === "MANAGE_LOOKUP" || /^lookup$/i.test(input)) {
      await save(session, "LOOKUP_ID", {});
      return { body: "Enter your appointment ID. It will be verified against this WhatsApp number." };
    }
    if (upperAction === "MENU_CLINIC" || (session.state === "MAIN_MENU" && /^(clinic|location)$/i.test(input))) {
      const locations = await d.locationService.listLocations();
      return { body: `Clinic locations:\n\n${locations.map((location) => `${location.city}: ${location.clinicName} — ${location.status}`).join("\n")}` };
    }
    if (upperAction === "MENU_PROFILE" || upperAction === "MENU_TREATMENTS" || (session.state === "MAIN_MENU" && /^(doctor|profile)$/i.test(input))) {
      return { body: "Dr. Sohaib is a specialist physician and surgeon. Consultation schedules depend on the selected active clinic." };
    }
    if (upperAction === "MENU_STAFF" || (session.state === "MAIN_MENU" && /^(staff|human)$/i.test(input))) {
      session.humanRequired = true;
      session.aiPaused = true;
      await save(session, "STAFF_HANDOVER", {});
      return { body: tr(lang, "staff") };
    }

    if (upperAction.startsWith("BOOK_LOCATION_") || session.state === "BOOKING_LOCATION") {
      const locationId = upperAction.startsWith("BOOK_LOCATION_") ? action.slice("BOOK_LOCATION_".length) : input;
      try {
        const location = await d.locationService.getBookableLocation(locationId);
        await save(session, "BOOKING_NAME", {
          locationId: String(location._id || location.code),
          locationName: `${location.clinicName}, ${location.city}`,
          district: location.city
        });
        return { body: `District selected: ${location.city}.\n\n${tr(lang, "name")}` };
      } catch {
        return { body: "That clinic selection is invalid or is no longer accepting bookings. Type BACK or select an active clinic." };
      }
    }

    if (upperAction.startsWith("BOOK_DATES_MORE_") && session.state === "BOOKING_DATE") {
      return dateMenu(session, "booking", Number(upperAction.split("_").pop()) || 0);
    }
    if (upperAction.startsWith("BOOK_DATE_") || session.state === "BOOKING_DATE") {
      const date = upperAction.startsWith("BOOK_DATE_") ? action.slice("BOOK_DATE_".length) : input;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { body: "That date selection is invalid. Select a displayed date or type BACK." };
      const dates = await d.availabilityService.getAvailableDates(session.context.locationId, 60);
      if (!dates.some((entry) => entry.date === date)) return { body: "That date is closed, blocked, expired, or no longer available. Select another displayed date." };
      await save(session, "BOOKING_TIME", { ...session.context, date });
      return slotMenu(session, "booking");
    }

    if (upperAction.startsWith("BOOK_SLOTS_MORE_") && session.state === "BOOKING_TIME") {
      return slotMenu(session, "booking", Number(upperAction.split("_").pop()) || 0);
    }
    if (upperAction.startsWith("BOOK_SLOT_") || session.state === "BOOKING_TIME") {
      const time = upperAction.startsWith("BOOK_SLOT_") ? action.slice("BOOK_SLOT_".length) : input;
      const slots = await d.availabilityService.getAvailableSlots(session.context.locationId, session.context.date);
      if (!slots.some((slot) => slot.time === time && slot.available)) return { body: "That time is invalid, blocked, expired, or was just booked. Select another displayed time." };
      await save(session, "BOOKING_CONSENT", { ...session.context, time });
      return msg.buttons(
        `${CONSENT_TEXT} Do you consent?`,
        [{ id: "BOOK_CONSENT_YES", title: "Yes, I consent" }, { id: "BOOK_CONSENT_NO", title: "No" }, { id: "MENU_MAIN", title: "Main Menu" }]
      );
    }

    if (session.state === "BOOKING_NAME") {
      if (input.length < 2 || input.length > 160) return { body: tr(lang, "invalidName") };
      await save(session, "BOOKING_PHONE", { ...session.context, fullName: input });
      return msg.buttons(
        `Use ${maskedPhone(phone)} as the appointment phone number?`,
        [{ id: "BOOK_PHONE_CONFIRM", title: "✅ Use This Number" }, { id: "MENU_MAIN", title: "🏠 Main Menu" }]
      );
    }

    if (session.state === "BOOKING_PHONE") {
      const selectedPhone = upperAction === "BOOK_PHONE_CONFIRM" ? phone : normalizePhone(input);
      if (!selectedPhone || selectedPhone !== phone) {
        return { body: "For security, the appointment phone must match this WhatsApp number. Select Use this number." };
      }
      await save(session, "BOOKING_REASON", { ...session.context, bookingPhone: selectedPhone });
      return msg.list(tr(lang, "reason"), consultationReasons.map((reason, index) => ({
        id: `BOOK_REASON_${index}`, title: `${departmentIcons[index]} ${reason}`.slice(0, 24)
      })), "🩺 Select Department");
    }

    if (upperAction.startsWith("BOOK_REASON_") || session.state === "BOOKING_REASON") {
      let reason = input;
      if (upperAction.startsWith("BOOK_REASON_")) reason = consultationReasons[Number(action.slice("BOOK_REASON_".length))];
      if (!reason || reason.length > 1000) return { body: "Select a displayed reason or type a short consultation reason." };
      await save(session, "BOOKING_DATE", { ...session.context, reason, department: reason });
      return dateMenu(session, "booking");
    }

    if (session.state === "BOOKING_CONSENT") {
      if (upperAction === "BOOK_CONSENT_NO" || /^(no|decline)$/i.test(input)) {
        await save(session, "MAIN_MENU", {});
        return { body: "No appointment was created because consent was not provided. Type MENU to continue." };
      }
      if (upperAction !== "BOOK_CONSENT_YES" && !/^(yes|i consent|consent|agree)$/i.test(input)) {
        return { body: "Consent is required. Select Yes, No, or Main Menu." };
      }
      await save(session, "BOOKING_REVIEW", { ...session.context, consentGiven: true });
      return bookingReview(session);
    }

    if (upperAction === "CONFIRM_BOOKING" && session.state === "BOOKING_REVIEW") {
      try {
        const appointment = await d.appointmentService.createAppointment({
          fullName: session.context.fullName,
          phone: session.context.bookingPhone || phone,
          reason: session.context.reason,
          date: session.context.date,
          time: session.context.time,
          locationId: session.context.locationId,
          consentGiven: session.context.consentGiven === true,
          preferredLanguage: lang
        }, { source: "whatsapp" });
        await save(session, "MAIN_MENU", {});
        return { body: `Appointment confirmed.\n\n${appointmentSummary(appointment)}\n\nType MENU for more options.` };
      } catch (error) {
        return { body: error?.statusCode ? `${error.message} Select another slot or type MENU.` : "The appointment could not be completed. Please select another slot or contact clinic staff." };
      }
    }

    if (session.state === "LOOKUP_ID") {
      try {
        const appointment = await d.appointmentService.lookupAppointment({ appointmentId: input, phone });
        return manageAppointment(session, phone, appointment);
      } catch {
        return { body: "No appointment matched that ID and this WhatsApp number. Check the ID or type MENU." };
      }
    }

    if (upperAction.startsWith("MANAGE_CANCEL_") || (/^cancel$/i.test(input) && session.context?.appointmentId)) {
      const appointmentId = upperAction.startsWith("MANAGE_CANCEL_") ? action.slice("MANAGE_CANCEL_".length) : session.context.appointmentId;
      await save(session, "CANCEL_CONFIRM", { appointmentId });
      return msg.buttons(`Cancel appointment ${appointmentId}?`, [
        { id: "CONFIRM_CANCEL", title: "Yes, cancel" }, { id: "BACK", title: "Back" }, { id: "MENU_MAIN", title: "Main Menu" }
      ]);
    }
    if (upperAction === "CONFIRM_CANCEL" && session.state === "CANCEL_CONFIRM") {
      try {
        const appointment = await d.appointmentService.cancelAppointment(
          { appointmentId: session.context.appointmentId, phone, reason: "Cancelled through WhatsApp" },
          { source: "whatsapp" }
        );
        await save(session, "MAIN_MENU", {});
        return { body: `Appointment ${appointment.appointmentId} has been cancelled. Type MENU for more options.` };
      } catch {
        return { body: "The appointment could not be cancelled. Verify it is still eligible or contact clinic staff." };
      }
    }

    if (upperAction.startsWith("MANAGE_RESCHEDULE_") || (/^reschedule$/i.test(input) && session.context?.appointmentId)) {
      const appointmentId = upperAction.startsWith("MANAGE_RESCHEDULE_") ? action.slice("MANAGE_RESCHEDULE_".length) : session.context.appointmentId;
      await save(session, "RESCHEDULE_LOCATION", { appointmentId });
      return locationMenu(session, "reschedule");
    }

    if (upperAction.startsWith("RESCHEDULE_LOCATION_") || session.state === "RESCHEDULE_LOCATION") {
      const locationId = upperAction.startsWith("RESCHEDULE_LOCATION_") ? action.slice("RESCHEDULE_LOCATION_".length) : input;
      try {
        const location = await d.locationService.getBookableLocation(locationId);
        await save(session, "RESCHEDULE_DATE", { ...session.context, locationId: String(location._id || location.code), locationName: `${location.clinicName}, ${location.city}` });
        return dateMenu(session, "reschedule");
      } catch {
        return { body: "That clinic selection is invalid or unavailable. Type BACK or select an active clinic." };
      }
    }
    if (upperAction.startsWith("RESCHEDULE_DATES_MORE_") && session.state === "RESCHEDULE_DATE") {
      return dateMenu(session, "reschedule", Number(upperAction.split("_").pop()) || 0);
    }
    if (upperAction.startsWith("RESCHEDULE_DATE_") || session.state === "RESCHEDULE_DATE") {
      const date = upperAction.startsWith("RESCHEDULE_DATE_") ? action.slice("RESCHEDULE_DATE_".length) : input;
      const dates = await d.availabilityService.getAvailableDates(session.context.locationId, 60);
      if (!dates.some((entry) => entry.date === date)) return { body: "That date is closed, blocked, expired, or unavailable. Select another date." };
      await save(session, "RESCHEDULE_TIME", { ...session.context, date });
      return slotMenu(session, "reschedule");
    }
    if (upperAction.startsWith("RESCHEDULE_SLOTS_MORE_") && session.state === "RESCHEDULE_TIME") {
      return slotMenu(session, "reschedule", Number(upperAction.split("_").pop()) || 0);
    }
    if (upperAction.startsWith("RESCHEDULE_SLOT_") || session.state === "RESCHEDULE_TIME") {
      const time = upperAction.startsWith("RESCHEDULE_SLOT_") ? action.slice("RESCHEDULE_SLOT_".length) : input;
      const slots = await d.availabilityService.getAvailableSlots(session.context.locationId, session.context.date);
      if (!slots.some((slot) => slot.time === time && slot.available)) return { body: "That time is invalid, blocked, expired, or occupied. Select another time." };
      await save(session, "RESCHEDULE_REVIEW", { ...session.context, time });
      return rescheduleReview(session);
    }
    if (upperAction === "CONFIRM_RESCHEDULE" && session.state === "RESCHEDULE_REVIEW") {
      try {
        const appointment = await d.appointmentService.rescheduleAppointment({
          appointmentId: session.context.appointmentId,
          phone,
          locationId: session.context.locationId,
          date: session.context.date,
          time: session.context.time,
          reason: "Rescheduled through WhatsApp"
        }, { source: "whatsapp" });
        await save(session, "MAIN_MENU", {});
        return { body: `Appointment rescheduled.\n\n${appointmentSummary(appointment)}\n\nType MENU for more options.` };
      } catch {
        return { body: "The appointment could not be rescheduled. The slot may have been taken; select another slot or contact clinic staff." };
      }
    }

    await save(session, "MAIN_MENU", {});
    return { ...msg.mainMenu(lang), body: `That selection was invalid or expired.\n\n${tr(lang, "welcome")}` };
  };
}

module.exports = { createConversationOrchestrator, handleIncomingMessage: createConversationOrchestrator() };
