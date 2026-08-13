const test = require("node:test");
const assert = require("node:assert/strict");
const { createConversationOrchestrator } = require("../../src/conversation/orchestrator");

function fakeSession(phoneE164) {
  return {
    phoneE164,
    language: "en",
    state: "MAIN_MENU",
    context: {},
    async save() {}
  };
}

test("guided WhatsApp booking follows district, name, phone, department, date, time and confirmation", async () => {
  let session;
  let bookingInput;
  const models = {
    ConversationSession: {
      async findOne() { return session || null; },
      async create(input) { session = Object.assign(fakeSession(input.phoneE164), input); return session; }
    },
    Appointment: { find() { return { sort: async () => [] }; } },
    EmergencyAlert: { async create() {} }
  };
  const location = { code: "BWP", city: "Bahawalpur", clinicName: "Iqbal Hospital" };
  const handle = createConversationOrchestrator({
    models,
    locationService: {
      async listLocations() { return [location]; },
      async getBookableLocation() { return location; }
    },
    availabilityService: {
      async getAvailableDates() { return [{ date: "2030-01-07", availableSlots: 1 }]; },
      async getAvailableSlots() { return [{ time: "16:30", available: true }]; }
    },
    appointmentService: {
      async createAppointment(input) {
        bookingInput = input;
        return {
          ...input,
          appointmentId: "SOH-BWP-20300107-001",
          tokenNumber: "001",
          status: "confirmed",
          locationSnapshot: location
        };
      }
    }
  });

  const send = (text, replyId = "") => handle({ phoneE164: "+923001234567", text, replyId });
  assert.equal((await send("Hi")).sections[0].rows[0].id, "MENU_BOOK");
  assert.equal((await send("Book Appointment", "MENU_BOOK")).sections[0].rows[0].id, "BOOK_LOCATION_BWP");
  assert.match((await send("Bahawalpur", "BOOK_LOCATION_BWP")).body, /name/i);
  assert.equal(session.state, "BOOKING_NAME");
  assert.match((await send("Synthetic Patient")).body, /phone number/i);
  assert.equal((await send("Use", "BOOK_PHONE_CONFIRM")).sections[0].rows[0].id, "BOOK_REASON_0");
  assert.equal((await send("Orthopaedics", "BOOK_REASON_0")).sections[0].rows[0].id, "BOOK_DATE_2030-01-07");
  assert.equal((await send("Date", "BOOK_DATE_2030-01-07")).sections[0].rows[0].id, "BOOK_SLOT_16:30");
  assert.match((await send("Time", "BOOK_SLOT_16:30")).body, /consent/i);
  assert.match((await send("Yes", "BOOK_CONSENT_YES")).body, /Review your appointment/i);
  assert.match((await send("Confirm", "CONFIRM_BOOKING")).body, /Appointment confirmed/i);
  assert.equal(bookingInput.phone, "+923001234567");
  assert.equal(bookingInput.consentGiven, true);
});

test("document menu does not direct patients to the legacy public upload", async () => {
  let session = fakeSession("+923001234567");
  const handle = createConversationOrchestrator({
    models: {
      ConversationSession: { async findOne() { return session; } },
      Appointment: { find() { return { sort: async () => [] }; } },
      EmergencyAlert: { async create() {} }
    }
  });
  const reply = await handle({ phoneE164: session.phoneE164, replyId: "MENU_UPLOAD" });
  assert.match(reply.body, /authorized clinic staff/i);
  assert.doesNotMatch(reply.body, /\/uploads\//i);
});
