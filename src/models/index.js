const mongoose = require("mongoose");
const {
  WHATSAPP_MESSAGE_STATUSES,
  WHATSAPP_DELIVERY_STATUSES,
  REMINDER_DELIVERY_STATUSES
} = require("../domain/whatsappRules");
const { isValidTimeWindow, isValidTimezone, isValidWeeklyHours } = require("../domain/scheduleRules");

const { Schema } = mongoose;

const baseOptions = { timestamps: true };

// Auto-increment counter schema
const counterSchema = new Schema({
  key: { type: String, required: true, unique: true, trim: true },
  seq: { type: Number, default: 0 }
}, baseOptions);

// Staff User schema (User)
const staffUserSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { 
    type: String, 
    enum: ["super_admin", "doctor", "receptionist", "clinic_staff"], 
    default: "clinic_staff" 
  },
  isActive: { type: Boolean, default: true },
  failedLoginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date },
  passwordChangedAt: { type: Date },
  lastLoginAt: { type: Date }
}, baseOptions);

staffUserSchema.index({ role: 1, isActive: 1 });

// Refresh token schema
const refreshTokenSessionSchema = new Schema({
  staffUser: { type: Schema.Types.ObjectId, ref: "StaffUser", required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  userAgent: { type: String, maxlength: 600 },
  ip: { type: String, maxlength: 120 },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date }
}, baseOptions);

refreshTokenSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Patient schema
const patientSchema = new Schema({
  patientId: { type: String, unique: true, sparse: true },
  fullName: { type: String, required: true, trim: true, maxlength: 160 },
  phoneE164: { type: String, required: true, unique: true, trim: true },
  preferredLanguage: { type: String, default: "en", enum: ["en", "ur"] },
  age: { type: Number, min: 0, max: 130 },
  city: { type: String, default: "Bahawalpur" },
  gender: { type: String, enum: ["female", "male", "other", "not_provided"], default: "not_provided" },
  notes: { type: String, maxlength: 1000 },
  optOut: { type: Boolean, default: false },
  knownProfiles: [{
    normalizedName: { type: String, required: true, maxlength: 160 },
    fullName: { type: String, required: true, maxlength: 160 },
    age: { type: Number, min: 0, max: 130 },
    relationship: { type: String, enum: ["self", "family", "unknown"], default: "unknown" },
    lastVerifiedAt: { type: Date, required: true, default: Date.now }
  }]
}, baseOptions);

patientSchema.index({ fullName: "text", phoneE164: "text" });

// Patient Consent schema
const patientConsentSchema = new Schema({
  patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  phoneE164: { type: String, required: true, index: true },
  consentGiven: { type: Boolean, required: true },
  consentText: { type: String, required: true },
  consentTextVersion: { type: String, required: true, trim: true, maxlength: 80 },
  channel: { type: String, enum: ["website", "whatsapp", "staff"], required: true },
  language: { type: String, default: "en" },
  consentedAt: { type: Date, default: Date.now }
}, baseOptions);

const weeklyHourSchema = new Schema({
  day: { type: Number, required: true, min: 1, max: 7 },
  isOpen: { type: Boolean, required: true, default: false },
  start: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
  end: { type: String, required: true, match: /^\d{2}:\d{2}$/ }
}, { _id: false });

const blockedDateSchema = new Schema({
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  reason: { type: String, required: true, trim: true, maxlength: 500 },
  createdBy: { type: Schema.Types.ObjectId, ref: "StaffUser" },
  createdAt: { type: Date, required: true, default: Date.now }
}, { _id: false });

const blockedSlotSchema = new Schema({
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  time: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
  reason: { type: String, required: true, trim: true, maxlength: 500 },
  createdBy: { type: Schema.Types.ObjectId, ref: "StaffUser" },
  createdAt: { type: Date, required: true, default: Date.now }
}, { _id: false });

function defaultLocationWeeklyHours() {
  return [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    day,
    isOpen: day <= 4,
    start: "16:30",
    end: "20:30"
  }));
}

// Authoritative clinic schedule and availability schema.
const clinicLocationSchema = new Schema({
  clinicName: { type: String, required: true, trim: true, maxlength: 160 },
  city: { type: String, required: true, trim: true, maxlength: 100 },
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  fullAddress: { type: String, required: true, trim: true, maxlength: 500 },
  contactNumber: { type: String, trim: true, maxlength: 50 },
  status: { type: String, enum: ["Active", "Inactive", "Coming Soon"], default: "Active", index: true },
  timezone: { type: String, default: "Asia/Karachi", validate: { validator: isValidTimezone, message: "Invalid clinic timezone" } },
  weeklyHours: {
    type: [weeklyHourSchema],
    default: defaultLocationWeeklyHours,
    validate: {
      validator(hours) {
        if (!Array.isArray(hours) || hours.length !== 7 || new Set(hours.map((entry) => entry.day)).size !== 7) return false;
        return hours.every((entry) => isValidTimeWindow(entry.start, entry.end));
      },
      message: "Weekly hours must contain seven unique days with valid opening and closing times"
    }
  },
  slotDurationMinutes: { type: Number, default: 15, min: 5, max: 240 },
  sameDayBookingCutoffMinutes: { type: Number, default: 0, min: 0, max: 1440 },
  appointmentFee: { type: Number, min: 0, default: 2000 },
  blockedDates: {
    type: [blockedDateSchema],
    default: [],
    validate: { validator: (entries) => new Set(entries.map((entry) => entry.date)).size === entries.length, message: "Blocked dates must be unique" }
  },
  blockedSlots: {
    type: [blockedSlotSchema],
    default: [],
    validate: { validator: (entries) => new Set(entries.map((entry) => `${entry.date}|${entry.time}`)).size === entries.length, message: "Blocked slots must be unique" }
  },
  currentDelayMinutes: { type: Number, min: 0, max: 480, default: 0 },
  delayUpdatedAt: { type: Date },
  delayUpdatedBy: { type: Schema.Types.ObjectId, ref: "StaffUser" },
  displayOrder: { type: Number, default: 0 }
}, baseOptions);

clinicLocationSchema.index({ status: 1, displayOrder: 1 });
clinicLocationSchema.pre("validate", function validateSchedule(next) {
  if (!isValidWeeklyHours(this.weeklyHours, this.slotDurationMinutes)) {
    this.invalidate("weeklyHours", "Weekly time windows must divide evenly into the configured slot duration");
  }
  next();
});

// Doctor Profile Schema (Doctor)
const doctorProfileSchema = new Schema({
  doctorKey: { type: String, default: "dr-sohaib", unique: true },
  doctorName: { type: String, default: "" },
  profileImage: { type: String, default: "" },
  qualification: { type: String, default: "" },
  specialty: { type: String, default: "" },
  experience: { type: String, default: "" },
  services: { type: String, default: "" },
  consultationLocation: { type: String, default: "" },
  consultationDays: { type: String, default: "" },
  consultationTimings: { type: String, default: "" },
  bio: { type: String, default: "" }
}, baseOptions);

// Appointment schema
const appointmentSchema = new Schema({
  appointmentId: { type: String, required: true, unique: true, trim: true },
  tokenNumber: { type: String, required: true, trim: true },
  appointmentType: { type: String, enum: ["in_person", "online", "In-Person", "Online"], default: "in_person" },
  patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  patientSnapshot: {
    fullName: { type: String, required: true },
    phoneMasked: { type: String, required: true },
    age: { type: Number },
    gender: { type: String },
    preferredLanguage: { type: String }
  },
  phoneE164: { type: String, required: true, index: true },
  location: { type: Schema.Types.ObjectId, ref: "ClinicLocation", required: true, index: true },
  locationSnapshot: { 
    clinicName: String, 
    city: String, 
    code: String, 
    address: String, 
    contactNumber: String, 
    timezone: String 
  },
  reason: { type: String, required: true, maxlength: 1000 },
  optionalNote: { type: String, maxlength: 1000 },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  time: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
  slotTimezone: { type: String, default: "Asia/Karachi" },
  activeSlotKey: { type: String },
  idempotencyKey: { type: String, maxlength: 300 },
  idempotencyFingerprint: { type: String, maxlength: 64 },
  status: {
    type: String,
    enum: [
      "pending",
      "scheduled",
      "confirmed",
      "patient_confirmed",
      "arrived",
      "in_consultation",
      "completed",
      "rescheduled",
      "cancelled",
      "no_show",
      "waiting_for_earlier_slot"
    ],
    default: "pending",
    index: true
  },
  consent: { type: Schema.Types.ObjectId, ref: "PatientConsent" },
  source: { type: String, enum: ["website", "whatsapp", "staff"], default: "whatsapp" },
  reminderStatus: { type: String, enum: ["not_scheduled", "pending", "partially_sent", "sent", "failed", "cancelled"], default: "pending" },
  rescheduleCount: { type: Number, default: 0 },
  createdBy: { type: Schema.Types.ObjectId, ref: "StaffUser" },
  cancelledAt: { type: Date },
  cancellationReason: { type: String, maxlength: 1000 },
  cancellationSource: { type: String, enum: ["website", "whatsapp", "staff", "system"] },
  cancelledBy: { type: Schema.Types.ObjectId, ref: "StaffUser" },
  completedAt: { type: Date },
  arrivedAt: { type: Date },
  patientProvidedVisitSummary: {
    patientName: { type: String, maxlength: 160 },
    age: { type: Number, min: 0, max: 130 },
    concern: { type: String, maxlength: 500 },
    existingConditionShared: { type: String, maxlength: 500 },
    reportsAttached: { type: Number, min: 0, default: 0 },
    disclaimer: { type: String, maxlength: 300 },
    approvedAt: { type: Date },
    source: { type: String, enum: ["whatsapp_text", "whatsapp_voice"] }
  },
  doctorWelcomeSentAt: { type: Date },
  rescheduleHistory: [{
    previousLocation: { type: Schema.Types.ObjectId, ref: "ClinicLocation" },
    previousDate: String,
    previousTime: String,
    newLocation: { type: Schema.Types.ObjectId, ref: "ClinicLocation" },
    newDate: String,
    newTime: String,
    changedByType: { type: String, enum: ["patient", "staff", "system"] },
    changedByStaff: { type: Schema.Types.ObjectId, ref: "StaffUser" },
    reason: { type: String, maxlength: 1000 },
    changedAt: { type: Date, default: Date.now }
  }]
}, baseOptions);

const bookingRequestSchema = new Schema({
  key: { type: String, required: true, maxlength: 300 },
  fingerprint: { type: String, required: true, maxlength: 64 },
  status: { type: String, enum: ["processing", "completed", "failed"], default: "processing", index: true },
  appointment: { type: Schema.Types.ObjectId, ref: "Appointment" },
  leaseExpiresAt: { type: Date, required: true },
  errorCode: { type: String, maxlength: 80 }
}, baseOptions);
bookingRequestSchema.index({ key: 1 }, { unique: true, name: "uniq_booking_request_key" });

appointmentSchema.index({ location: 1, date: 1, time: 1, status: 1 });
appointmentSchema.index({ appointmentId: 1, phoneE164: 1 });
appointmentSchema.index({ activeSlotKey: 1 }, { unique: true, sparse: true, name: "uniq_active_appointment_slot" });
appointmentSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true, name: "uniq_appointment_idempotency" });

// Reschedule History schema
const rescheduleHistorySchema = new Schema({
  appointment: { type: Schema.Types.ObjectId, ref: "Appointment", required: true, index: true },
  previousDate: { type: String, required: true },
  previousTime: { type: String, required: true },
  previousLocation: { type: Schema.Types.ObjectId, ref: "ClinicLocation" },
  newDate: { type: String, required: true },
  newTime: { type: String, required: true },
  newLocation: { type: Schema.Types.ObjectId, ref: "ClinicLocation" },
  changedByType: { type: String, enum: ["patient", "staff", "system"], required: true },
  changedByStaff: { type: Schema.Types.ObjectId, ref: "StaffUser" },
  reason: { type: String, maxlength: 1000 }
}, baseOptions);

// Conversation Session schema (Conversation)
const conversationSessionSchema = new Schema({
  phoneE164: { type: String, required: true, unique: true },
  patient: { type: Schema.Types.ObjectId, ref: "Patient" },
  language: { type: String, default: "en", enum: ["en", "ur"] },
  intent: { type: String, default: "menu" },
  state: { type: String, default: "idle" },
  context: { type: Schema.Types.Mixed, default: {} },
  humanRequired: { type: Boolean, default: false },
  aiPaused: { type: Boolean, default: false },
  takenOverBy: { type: Schema.Types.ObjectId, ref: "StaffUser" },
  handoffReason: { type: String, maxlength: 240 },
  lastAiIntent: { type: String, maxlength: 60 },
  lastAiConfidence: { type: Number, min: 0, max: 1 },
  lastMessageAt: { type: Date, default: Date.now },
  serviceWindowExpiresAt: { type: Date }
}, baseOptions);

conversationSessionSchema.index({ humanRequired: 1, aiPaused: 1, lastMessageAt: -1 });

// WhatsApp Message schema (Message)
const whatsappMessageSchema = new Schema({
  metaMessageId: { type: String, unique: true, sparse: true },
  direction: { type: String, enum: ["incoming", "outgoing"], required: true },
  senderType: { type: String, enum: ["patient", "ai", "staff"], default: "patient" },
  senderStaff: { type: Schema.Types.ObjectId, ref: "StaffUser" },
  phoneE164: { type: String, required: true, index: true },
  conversation: { type: Schema.Types.ObjectId, ref: "ConversationSession" },
  messageType: { type: String, default: "text" },
  body: { type: String, maxlength: 6000 },
  mediaUrl: { type: String },
  status: {
    type: String,
    enum: WHATSAPP_MESSAGE_STATUSES,
    default: "received",
    index: true
  },
  error: { type: String, maxlength: 500 },
  failureCode: { type: String, maxlength: 100 },
  failureReason: { type: String, maxlength: 500 },
  metaTimestamp: { type: Date },
  templateName: { type: String, maxlength: 512 },
  templateLanguage: { type: String, maxlength: 35 },
  serviceWindowExpiresAt: { type: Date }
}, baseOptions);

whatsappMessageSchema.index({ createdAt: -1 });

const messageDeliveryStatusSchema = new Schema({
  eventKey: { type: String, required: true, unique: true },
  metaMessageId: { type: String, required: true, index: true },
  phoneE164: { type: String, trim: true },
  status: { type: String, enum: WHATSAPP_DELIVERY_STATUSES, required: true },
  timestamp: { type: Date, required: true },
  failureCode: { type: String, maxlength: 100 },
  failureReason: { type: String, maxlength: 500 }
}, baseOptions);

messageDeliveryStatusSchema.index({ metaMessageId: 1, status: 1, timestamp: 1 }, { unique: true });

// Clinic & Doctor Settings
const clinicSettingsSchema = new Schema({
  key: { type: String, default: "default", unique: true },
  doctorName: { type: String, default: "" },
  clinicName: { type: String, default: "" },
  city: { type: String, default: "" },
  address: { type: String, default: "" },
  consultationDays: { type: String, default: "" },
  consultationTime: { type: String, default: "" },
  remindersEnabled: { type: Boolean, default: true },
  reminderIntervalsMinutes: {
    type: [{ type: Number, min: 1, max: 525600 }],
    default: [4320, 1440, 120],
    validate: {
      validator(values) {
        return Array.isArray(values) && values.length <= 10 && new Set(values).size === values.length;
      },
      message: "Reminder intervals must be unique and contain no more than ten values"
    }
  },
  updatedBy: { type: Schema.Types.ObjectId, ref: "StaffUser" }
}, baseOptions);

// Medical Report Upload schema
const medicalReportSchema = new Schema({
  reportId: { type: String, unique: true, sparse: true },
  patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  patientPhone: { type: String, required: true, index: true },
  appointmentId: { type: String, default: "" },
  tokenNumber: { type: String, default: "" },
  appointment: { type: Schema.Types.ObjectId, ref: "Appointment" },
  reportTitle: { type: String, required: true, trim: true, maxlength: 200 },
  documentType: { type: String, enum: ["mri", "xray", "prescription", "lab", "discharge", "other", "blood_test"], default: "other" },
  originalFilename: { type: String, required: true, trim: true, maxlength: 255 },
  storageKey: { type: String, required: true, unique: true, sparse: true, select: false },
  mimeType: { type: String, required: true, enum: ["application/pdf", "image/jpeg", "image/png"] },
  fileSize: { type: Number, required: true, min: 1 },
  uploadedByType: { type: String, required: true, enum: ["patient", "staff"] },
  uploadedByStaff: { type: Schema.Types.ObjectId, ref: "StaffUser" },
  uploadedAt: { type: Date, required: true, default: Date.now },
  fileStatus: { type: String, required: true, enum: ["active", "deleting", "deleted", "quarantined"], default: "active", index: true },
  deletedAt: { type: Date },
  deletedBy: { type: Schema.Types.ObjectId, ref: "StaffUser" },
  notes: { type: String, maxlength: 1000 },
  status: { type: String, enum: ["New", "Uploaded", "Received", "Under Review", "Reviewed", "More Information Required", "pending", "archived"], default: "New" },
  reviewedBy: { type: Schema.Types.ObjectId, ref: "StaffUser" },
  reviewedAt: { type: Date }
}, baseOptions);

// Online Consultation Request schema
const onlineConsultationSchema = new Schema({
  consultationId: { type: String, unique: true, sparse: true },
  patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  patientPhone: { type: String, required: true, index: true },
  fullName: { type: String },
  age: { type: Number },
  city: { type: String },
  patientType: { type: String, enum: ["new", "existing"], default: "new" },
  appointmentId: { type: String, default: "" },
  preferredDate: { type: String },
  preferredTime: { type: String },
  symptoms: { type: String, required: true, maxlength: 2000 },
  medicalHistory: { type: String, maxlength: 2000 },
  reportFileName: { type: String, default: "" },
  contactPhone: { type: String, required: true },
  status: { type: String, enum: ["Pending", "Under Review", "Approved", "Scheduled", "Completed", "Rejected", "Cancelled", "pending", "under_review", "scheduled", "completed", "rejected"], default: "Pending" },
  doctorNotes: { type: String, maxlength: 1000 },
  assignedDoctor: { type: Schema.Types.ObjectId, ref: "StaffUser" }
}, baseOptions);

// Emergency Alert schema
const emergencyAlertSchema = new Schema({
  patient: { type: Schema.Types.ObjectId, ref: "Patient" },
  phoneE164: { type: String, required: true, index: true },
  conversation: { type: Schema.Types.ObjectId, ref: "ConversationSession" },
  alertMessage: { type: String, required: true, maxlength: 2000 },
  priority: { type: String, enum: ["high", "critical"], default: "critical" },
  status: { type: String, enum: ["open", "acknowledged", "resolved"], default: "open", index: true },
  resolvedBy: { type: Schema.Types.ObjectId, ref: "StaffUser" },
  resolutionNotes: { type: String, maxlength: 1000 },
  resolvedAt: { type: Date }
}, baseOptions);

// Email Notification Outbox schema
const emailNotificationOutboxSchema = new Schema({
  appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", index: true },
  notificationType: { type: String, required: true },
  dedupeKey: { type: String, required: true, maxlength: 300 },
  recipient: { type: String, required: true },
  channel: { type: String, default: "email" },
  requestId: { type: String },
  templateKey: { type: String },
  status: { type: String, enum: ["queued", "sending", "sent", "failed", "dead_letter"], default: "queued", index: true },
  attemptCount: { type: Number, default: 0 },
  nextRetryAt: { type: Date },
  lockedAt: { type: Date },
  lockExpiresAt: { type: Date },
  lastAttemptAt: { type: Date },
  failedAt: { type: Date },
  sentAt: { type: Date },
  providerMessageId: { type: String },
  failureCode: { type: String },
  failureMessageSafe: { type: String }
}, baseOptions);

emailNotificationOutboxSchema.index({ status: 1, nextRetryAt: 1 });
emailNotificationOutboxSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } }
);

// Reminder Job schema (Reminder)
const reminderJobSchema = new Schema({
  dedupeKey: { type: String, unique: true, sparse: true, maxlength: 300 },
  appointment: { type: Schema.Types.ObjectId, ref: "Appointment", index: true },
  patient: { type: Schema.Types.ObjectId, ref: "Patient", index: true },
  phoneE164: { type: String, required: true, index: true },
  type: { type: String, enum: ["appointment_reminder", "follow_up_reminder", "arrival_update"], default: "appointment_reminder" },
  dueAt: { type: Date, required: true, index: true },
  message: { type: String, required: true, maxlength: 2000 },
  status: { type: String, enum: REMINDER_DELIVERY_STATUSES, default: "pending" },
  attempts: { type: Number, default: 0 },
  sentAt: { type: Date },
  metaMessageId: { type: String, index: true, sparse: true },
  intervalMinutes: { type: Number },
  scheduleRevision: { type: Number, default: 0 },
  lastError: { type: String, maxlength: 500 },
  failureCode: { type: String, maxlength: 100 },
  lastAttemptAt: { type: Date }
}, baseOptions);

reminderJobSchema.index(
  { appointment: 1, type: 1, intervalMinutes: 1, scheduleRevision: 1 },
  { unique: true, partialFilterExpression: { appointment: { $type: "objectId" }, type: "appointment_reminder" } }
);

// Staff Note schema
const staffNoteSchema = new Schema({
  targetType: { type: String, enum: ["patient", "appointment", "conversation"], required: true },
  targetId: { type: String, required: true, index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "StaffUser", required: true },
  note: { type: String, required: true, maxlength: 2000 }
}, baseOptions);

// Notification schema
const notificationSchema = new Schema({
  title: { type: String, required: true },
  message: { type: String, required: true, maxlength: 2000 },
  type: { type: String, enum: ["info", "success", "warning", "emergency"], default: "info" },
  readBy: [{ type: Schema.Types.ObjectId, ref: "StaffUser" }]
}, baseOptions);

// Audit Log schema
const auditLogSchema = new Schema({
  actorType: { type: String, enum: ["staff", "patient", "system", "whatsapp"], required: true },
  actorStaff: { type: Schema.Types.ObjectId, ref: "StaffUser" },
  actorPatient: { type: Schema.Types.ObjectId, ref: "Patient" },
  actorId: { type: String, maxlength: 120 },
  actorPhone: { type: String, maxlength: 40 },
  actorRole: { type: String, enum: ["super_admin", "doctor", "receptionist", "clinic_staff"] },
  action: { type: String, required: true, index: true },
  entityType: { type: String, required: true },
  entityId: { type: String },
  targetType: { type: String },
  targetId: { type: String },
  beforeSummary: { type: Schema.Types.Mixed },
  afterSummary: { type: Schema.Types.Mixed },
  metadata: { type: Schema.Types.Mixed },
  requestId: { type: String, maxlength: 100 },
  ip: { type: String, maxlength: 120 },
  userAgent: { type: String, maxlength: 600 }
}, baseOptions);

auditLogSchema.index({ createdAt: -1 });

const StaffUser = mongoose.model("StaffUser", staffUserSchema);
const Patient = mongoose.model("Patient", patientSchema);
const ClinicLocation = mongoose.model("ClinicLocation", clinicLocationSchema);
const DoctorProfile = mongoose.model("DoctorProfile", doctorProfileSchema);
const Appointment = mongoose.model("Appointment", appointmentSchema);
const MedicalReport = mongoose.model("MedicalReport", medicalReportSchema);
const OnlineConsultation = mongoose.model("OnlineConsultation", onlineConsultationSchema);
const EmergencyAlert = mongoose.model("EmergencyAlert", emergencyAlertSchema);
const EmailNotificationOutbox = mongoose.model("EmailNotificationOutbox", emailNotificationOutboxSchema);
const ReminderJob = mongoose.model("ReminderJob", reminderJobSchema);
const ConversationSession = mongoose.model("ConversationSession", conversationSessionSchema);
const WhatsAppMessage = mongoose.model("WhatsAppMessage", whatsappMessageSchema);
const MessageDeliveryStatus = mongoose.model("MessageDeliveryStatus", messageDeliveryStatusSchema);

const models = {
  Counter: mongoose.model("Counter", counterSchema),
  StaffUser,
  User: StaffUser, // Alias
  RefreshTokenSession: mongoose.model("RefreshTokenSession", refreshTokenSessionSchema),
  Patient,
  PatientConsent: mongoose.model("PatientConsent", patientConsentSchema),
  BookingRequest: mongoose.model("BookingRequest", bookingRequestSchema),
  ClinicLocation,
  Clinic: ClinicLocation, // Alias
  DoctorProfile,
  Doctor: DoctorProfile, // Alias
  Appointment,
  RescheduleHistory: mongoose.model("RescheduleHistory", rescheduleHistorySchema),
  ConversationSession,
  Conversation: ConversationSession, // Alias
  WhatsAppMessage,
  MessageDeliveryStatus,
  Message: WhatsAppMessage, // Alias
  ClinicSettings: mongoose.model("ClinicSettings", clinicSettingsSchema),
  MedicalReport,
  OnlineConsultation,
  EmergencyAlert,
  EmailNotificationOutbox,
  ReminderJob,
  Reminder: ReminderJob, // Alias
  StaffNote: mongoose.model("StaffNote", staffNoteSchema),
  Notification: mongoose.model("Notification", notificationSchema),
  AuditLog: mongoose.model("AuditLog", auditLogSchema)
};

module.exports = models;
