const { MedicalReport, Appointment } = require("../models");
const { config } = require("../config/env");
const { normalizePhone } = require("../utils/security");
const { lookupAppointment } = require("./appointmentService");
const { getMedicalFileStorage } = require("./medicalFileStorage");
const { validateMedicalFile, createReportId } = require("./medicalFileService");
const { downloadMetaMedia } = require("./whatsappService");
const { audit } = require("./auditService");
const { logError } = require("../utils/safeLogger");

const MEDICAL_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"];

async function storeWhatsAppReport({ phone, appointmentId, mediaId, filename, downloadMedia = downloadMetaMedia }) {
  const phoneE164 = normalizePhone(phone);
  const appointment = await lookupAppointment({ appointmentId, phone: phoneE164 });
  const media = await downloadMedia(mediaId, { maxBytes: config.storage.maxUploadBytes, allowedMimeTypes: MEDICAL_MIME_TYPES });
  const safeOriginalName = String(filename || `medical-report.${media.mimeType === "application/pdf" ? "pdf" : media.mimeType === "image/png" ? "png" : "jpg"}`).slice(0, 255);
  const file = { buffer: media.buffer, size: media.fileSize, mimetype: media.mimeType, originalname: safeOriginalName };
  const metadata = validateMedicalFile(file);
  const storage = getMedicalFileStorage();
  let stored = false;
  try {
    await storage.putObject({ key: metadata.storageKey, body: media.buffer, contentType: metadata.mimeType });
    stored = true;
    const report = await MedicalReport.create({
      reportId: createReportId(), patient: appointment.patient, patientPhone: phoneE164,
      appointmentId: appointment.appointmentId, tokenNumber: appointment.tokenNumber,
      appointment: appointment._id, reportTitle: "Patient medical report", documentType: "other",
      ...metadata, uploadedByType: "patient", uploadedAt: new Date(), fileStatus: "active", status: "New"
    });
    const reportCount = await MedicalReport.countDocuments({ appointment: appointment._id, fileStatus: "active" });
    await Appointment.updateOne({ _id: appointment._id }, { $set: { "patientProvidedVisitSummary.reportsAttached": reportCount } });
    await audit({ actorType: "patient", actorPatient: appointment.patient, actorPhone: phoneE164, action: "report.uploaded_from_whatsapp", entityType: "report", entityId: String(report._id), metadata: { mimeType: report.mimeType, fileSize: report.fileSize, appointmentId: appointment.appointmentId } });
    return { reportId: report.reportId, reportCount };
  } catch (error) {
    if (stored) await storage.deleteObject({ key: metadata.storageKey }).catch((cleanupError) => logError("WhatsApp report cleanup failed", cleanupError));
    throw error;
  }
}

module.exports = { MEDICAL_MIME_TYPES, storeWhatsAppReport };
