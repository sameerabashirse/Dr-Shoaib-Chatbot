const crypto = require("crypto");
const { config } = require("../config/env");
const {
  ConversationSession,
  Appointment,
  MessageDeliveryStatus,
  ReminderJob,
  WhatsAppMessage
} = require("../models");
const { normalizePhone } = require("../utils/security");
const { shouldAdvanceDeliveryStatus } = require("../domain/whatsappRules");

const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANGUAGE_RE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;
let metaFetch = (...args) => fetch(...args);

function setMetaFetchForTests(fetchImplementation) {
  if (config.nodeEnv !== "test") throw new Error("Meta transport injection is only available in tests.");
  metaFetch = fetchImplementation || ((...args) => fetch(...args));
}

function isWhatsAppConfigured() {
  return Boolean(config.whatsapp.accessToken && config.whatsapp.phoneNumberId);
}

function verifyMetaSignature(rawBody, signatureHeader, secret = config.whatsapp.metaAppSecret) {
  if (!secret) return !config.isProduction;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody || Buffer.from("")).digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function verifyWebhookToken(receivedToken, expectedToken = config.whatsapp.verifyToken) {
  const received = Buffer.from(String(receivedToken || "").trim());
  const expected = Buffer.from(String(expectedToken || "").trim());
  if (!received.length || received.length !== expected.length) return false;
  return crypto.timingSafeEqual(received, expected);
}

function graphUrl(path) {
  return `https://graph.facebook.com/${config.whatsapp.graphVersion}/${path}`;
}

function safeFailure(data, httpStatus) {
  const metaError = data?.error || {};
  return {
    failureCode: String(metaError.code || metaError.error_subcode || `HTTP_${httpStatus || 0}`).slice(0, 100),
    failureReason: String(metaError.message || metaError.error_user_msg || `Meta API returned ${httpStatus || "an error"}`).slice(0, 500)
  };
}

async function downloadMetaMedia(mediaId, { maxBytes, allowedMimeTypes } = {}) {
  if (!isWhatsAppConfigured()) throw new Error("WhatsApp Cloud API is not configured.");
  if (!/^\d{5,40}$/.test(String(mediaId || ""))) throw new Error("Invalid WhatsApp media identifier.");
  const metadataResponse = await metaFetch(graphUrl(`${mediaId}?fields=id,mime_type,file_size`), {
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
    signal: AbortSignal.timeout(10000)
  });
  const metadata = await metadataResponse.json().catch(() => ({}));
  if (!metadataResponse.ok || !metadata.url) throw new Error("WhatsApp media metadata could not be retrieved.");
  const mimeType = String(metadata.mime_type || "").split(";")[0].trim().toLowerCase();
  const fileSize = Number(metadata.file_size || 0);
  if (allowedMimeTypes?.length && !allowedMimeTypes.includes(mimeType)) throw new Error("Unsupported WhatsApp media type.");
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || (maxBytes && fileSize > maxBytes)) throw new Error("WhatsApp media size is invalid.");

  const mediaResponse = await metaFetch(metadata.url, {
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!mediaResponse.ok) throw new Error("WhatsApp media could not be downloaded.");
  const contentLength = Number(mediaResponse.headers?.get?.("content-length") || 0);
  if (maxBytes && contentLength > maxBytes) throw new Error("WhatsApp media exceeds the allowed size.");
  const buffer = Buffer.from(await mediaResponse.arrayBuffer());
  if (!buffer.length || buffer.length !== fileSize || (maxBytes && buffer.length > maxBytes)) throw new Error("WhatsApp media download was incomplete.");
  return { buffer, mimeType, fileSize };
}

async function ensureSession(phoneE164, update = {}) {
  return ConversationSession.findOneAndUpdate(
    { phoneE164 },
    { $setOnInsert: { phoneE164 }, $set: { lastMessageAt: new Date(), ...update } },
    { upsert: true, new: true }
  );
}

async function createOutgoingLog({
  to, body, type = "text", senderType = "ai", senderStaff,
  templateName, templateLanguage, status = "queued", failureCode, failureReason
}) {
  const phoneE164 = normalizePhone(to);
  const session = await ensureSession(phoneE164);
  return WhatsAppMessage.create({
    direction: "outgoing",
    senderType,
    senderStaff,
    phoneE164,
    conversation: session._id,
    messageType: type,
    body,
    templateName,
    templateLanguage,
    status,
    error: failureReason,
    failureCode,
    failureReason
  });
}

async function failOutgoing(message, failureCode, failureReason) {
  message.status = "failed";
  message.failureCode = String(failureCode || "META_SEND_FAILED").slice(0, 100);
  message.failureReason = String(failureReason || "WhatsApp message could not be sent.").slice(0, 500);
  message.error = message.failureReason;
  await message.save();
  return {
    configured: isWhatsAppConfigured(),
    status: "failed",
    failureCode: message.failureCode,
    error: message.failureReason,
    message
  };
}

async function sendWhatsAppRequest(payload, to, bodyForLog, options = {}) {
  const message = await createOutgoingLog({
    to,
    body: bodyForLog,
    type: payload.type,
    senderType: options.senderType,
    senderStaff: options.senderStaff,
    templateName: options.templateName,
    templateLanguage: options.templateLanguage
  });
  if (!isWhatsAppConfigured()) {
    return failOutgoing(message, "NOT_CONFIGURED", "WhatsApp Cloud API is not configured.");
  }

  let response;
  let data;
  try {
    response = await metaFetch(graphUrl(`${config.whatsapp.phoneNumberId}/messages`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });
    data = await response.json().catch(() => ({}));
  } catch (error) {
    const code = error?.name === "TimeoutError" ? "META_TIMEOUT" : "META_NETWORK_ERROR";
    return failOutgoing(message, code, "The WhatsApp provider could not be reached.");
  }

  if (!response.ok) {
    const failure = safeFailure(data, response.status);
    return failOutgoing(message, failure.failureCode, failure.failureReason);
  }

  const metaMessageId = data?.messages?.[0]?.id;
  if (!metaMessageId) return failOutgoing(message, "META_RESPONSE_INVALID", "Meta accepted the request without returning a message ID.");
  message.metaMessageId = metaMessageId;
  message.status = "queued";
  await message.save();
  return { configured: true, status: "queued", metaMessageId, message };
}

async function sendText(to, body, options = {}) {
  const phoneE164 = normalizePhone(to);
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phoneE164?.replace("+", ""),
    type: "text",
    text: { preview_url: false, body }
  };
  return sendWhatsAppRequest(payload, phoneE164, body, options);
}

async function sendTemplate(to, templateName, languageCode, parameters = [], options = {}) {
  const phoneE164 = normalizePhone(to);
  if (!TEMPLATE_NAME_RE.test(String(templateName || ""))) {
    const message = await createOutgoingLog({
      to: phoneE164, body: "WhatsApp appointment notification", type: "template",
      senderType: options.senderType, senderStaff: options.senderStaff,
      templateName, templateLanguage: languageCode, status: "failed",
      failureCode: "TEMPLATE_NOT_CONFIGURED", failureReason: "The required WhatsApp template is not configured."
    });
    return { configured: false, status: "failed", failureCode: message.failureCode, error: message.failureReason, message };
  }
  if (!TEMPLATE_LANGUAGE_RE.test(String(languageCode || ""))) {
    const message = await createOutgoingLog({
      to: phoneE164, body: `Template: ${templateName}`, type: "template",
      senderType: options.senderType, senderStaff: options.senderStaff,
      templateName, templateLanguage: languageCode, status: "failed",
      failureCode: "TEMPLATE_LANGUAGE_INVALID", failureReason: "The configured WhatsApp template language is invalid."
    });
    return { configured: true, status: "failed", failureCode: message.failureCode, error: message.failureReason, message };
  }
  if (options.expectedParameterCount !== undefined && parameters.length !== options.expectedParameterCount) {
    const message = await createOutgoingLog({
      to: phoneE164, body: `Template: ${templateName}`, type: "template",
      senderType: options.senderType, senderStaff: options.senderStaff,
      templateName, templateLanguage: languageCode, status: "failed",
      failureCode: "TEMPLATE_PARAMETERS_INVALID", failureReason: "The WhatsApp template parameter count does not match its contract."
    });
    return { configured: true, status: "failed", failureCode: message.failureCode, error: message.failureReason, message };
  }

  const payload = {
    messaging_product: "whatsapp",
    to: phoneE164.replace("+", ""),
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components: parameters.length ? [{
        type: "body",
        parameters: parameters.map((value) => ({ type: "text", text: String(value) }))
      }] : []
    }
  };
  return sendWhatsAppRequest(payload, phoneE164, `Template: ${templateName}`, {
    ...options, templateName, templateLanguage: languageCode
  });
}

async function sendReplyButtons(to, body, buttons, options = {}) {
  const phoneE164 = normalizePhone(to);
  const payload = {
    messaging_product: "whatsapp", to: phoneE164.replace("+", ""), type: "interactive",
    interactive: {
      type: "button", body: { text: body },
      action: { buttons: buttons.slice(0, 3).map((button) => ({ type: "reply", reply: { id: button.id, title: button.title.slice(0, 20) } })) }
    }
  };
  return sendWhatsAppRequest(payload, phoneE164, body, options);
}

async function sendInteractiveList(to, body, buttonText, sections, options = {}) {
  const phoneE164 = normalizePhone(to);
  const normalizedSections = sections.map((section) => ({ ...section, rows: (section.rows || []).slice(0, 10) }));
  const payload = {
    messaging_product: "whatsapp", to: phoneE164.replace("+", ""), type: "interactive",
    interactive: { type: "list", body: { text: body }, action: { button: buttonText.slice(0, 20), sections: normalizedSections } }
  };
  return sendWhatsAppRequest(payload, phoneE164, body, options);
}

async function sendMediaById(to, mediaType, mediaId, caption = "") {
  if (!["audio", "video"].includes(mediaType)) throw new Error("Unsupported welcome media type.");
  if (!/^\d{5,40}$/.test(String(mediaId || ""))) throw new Error("Invalid welcome media identifier.");
  const phoneE164 = normalizePhone(to);
  const media = { id: String(mediaId) };
  if (caption && mediaType === "video") media.caption = String(caption).slice(0, 1024);
  return sendWhatsAppRequest(
    { messaging_product: "whatsapp", to: phoneE164.replace("+", ""), type: mediaType, [mediaType]: media },
    phoneE164,
    caption || "Doctor welcome message",
    { senderType: "ai" }
  );
}

async function markMessageAsRead(metaMessageId) {
  if (!isWhatsAppConfigured() || !metaMessageId) return { status: "failed" };
  try {
    const response = await metaFetch(graphUrl(`${config.whatsapp.phoneNumberId}/messages`), {
      method: "POST",
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: metaMessageId }),
      signal: AbortSignal.timeout(10000)
    });
    return { status: response.ok ? "read" : "failed" };
  } catch {
    return { status: "failed" };
  }
}

async function isServiceWindowOpen(phone) {
  const phoneE164 = normalizePhone(phone);
  return Boolean(await ConversationSession.exists({ phoneE164, serviceWindowExpiresAt: { $gt: new Date() } }));
}

async function sendStaffMessage(to, body, options = {}) {
  if (!(await isServiceWindowOpen(to))) {
    const message = await createOutgoingLog({
      to, body, senderType: "staff", senderStaff: options.senderStaff,
      status: "failed", failureCode: "SERVICE_WINDOW_CLOSED",
      failureReason: "The 24-hour WhatsApp service window is closed; an approved template is required."
    });
    return { configured: isWhatsAppConfigured(), status: "failed", failureCode: message.failureCode, error: message.failureReason, message };
  }
  return sendText(to, body, { senderType: "staff", senderStaff: options.senderStaff });
}

async function logIncomingMessage({ metaMessageId, phoneE164, body, messageType }) {
  const normalizedPhone = normalizePhone(phoneE164);
  const serviceWindowExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const session = await ensureSession(normalizedPhone, { serviceWindowExpiresAt });
  try {
    const message = await WhatsAppMessage.create({
      metaMessageId,
      direction: "incoming",
      senderType: "patient",
      phoneE164: normalizedPhone,
      conversation: session._id,
      messageType,
      body,
      status: "received",
      serviceWindowExpiresAt
    });
    return { duplicate: false, message, session };
  } catch (error) {
    if (error.code === 11000) return { duplicate: true, session };
    throw error;
  }
}

async function updateDeliveryStatus(status) {
  const nextStatus = String(status.status || "");
  const phoneE164 = normalizePhone(status.recipient_id || status.phone_number || "");
  const timestamp = status.timestamp && Number.isFinite(Number(status.timestamp))
    ? new Date(Number(status.timestamp) * 1000)
    : new Date();
  const failureCode = status.errors?.[0]?.code ? String(status.errors[0].code) : undefined;
  const failureReason = String(status.errors?.[0]?.title || status.errors?.[0]?.message || "").slice(0, 500) || undefined;
  const eventKey = crypto.createHash("sha256").update(`${status.id}|${nextStatus}|${timestamp.toISOString()}`).digest("hex");
  const deliveryEvent = await MessageDeliveryStatus.updateOne(
    { eventKey },
    { $setOnInsert: { metaMessageId: status.id, phoneE164, status: nextStatus, timestamp, failureCode, failureReason } },
    { upsert: true, runValidators: true }
  );

  const message = await WhatsAppMessage.findOne({ metaMessageId: status.id });
  if (message && shouldAdvanceDeliveryStatus(message.status, nextStatus)) {
    message.status = nextStatus === "deleted" ? message.status : nextStatus;
    message.metaTimestamp = timestamp;
    if (nextStatus === "failed") {
      message.failureCode = failureCode || "META_DELIVERY_FAILED";
      message.failureReason = failureReason || "Meta reported delivery failure.";
      message.error = message.failureReason;
    }
    await message.save();
  }
  if (["sent", "delivered", "read", "failed"].includes(nextStatus)) {
    const reminderJobs = await ReminderJob.find({ metaMessageId: status.id, status: { $ne: "cancelled" } }).select("appointment").lean();
    await ReminderJob.updateMany(
      { metaMessageId: status.id, status: { $ne: "cancelled" } },
      { $set: { status: nextStatus, ...(nextStatus === "sent" ? { sentAt: timestamp } : {}), ...(failureReason ? { lastError: failureReason } : {}) } }
    );
    for (const appointmentId of new Set(reminderJobs.map((job) => String(job.appointment || "")).filter(Boolean))) {
      const outstanding = await ReminderJob.countDocuments({
        appointment: appointmentId,
        status: { $in: ["pending", "processing", "queued"] }
      });
      const failed = await ReminderJob.countDocuments({ appointment: appointmentId, status: "failed" });
      await Appointment.updateOne(
        { _id: appointmentId },
        { $set: { reminderStatus: outstanding ? "partially_sent" : (failed ? "failed" : "sent") } }
      );
    }
  }
  return { duplicate: deliveryEvent.upsertedCount === 0, message };
}

function extractWebhookMessages(body) {
  const changes = body?.entry?.flatMap((entry) => entry.changes || []) || [];
  const messages = [];
  const statuses = [];
  for (const change of changes) {
    const value = change.value || {};
    if (Array.isArray(value.statuses)) statuses.push(...value.statuses);
    if (!Array.isArray(value.messages)) continue;
    for (const message of value.messages) {
      const text = message.text?.body
        || message.button?.text
        || message.interactive?.button_reply?.title
        || message.interactive?.list_reply?.title
        || "";
      messages.push({
        metaMessageId: message.id,
        phoneE164: normalizePhone(message.from),
        type: message.type,
        body: text,
        replyId: message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || message.button?.payload || "",
        replyTitle: message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || message.button?.text || "",
        mediaId: message.image?.id || message.document?.id || message.audio?.id || message.video?.id || message.sticker?.id || "",
        filename: String(message.document?.filename || "").slice(0, 255),
        mimeType: String(message.document?.mime_type || message.image?.mime_type || message.audio?.mime_type || "").slice(0, 100)
      });
    }
  }
  return { messages, statuses };
}

module.exports = {
  isWhatsAppConfigured,
  verifyMetaSignature,
  verifyWebhookToken,
  sendText,
  sendReplyButtons,
  sendInteractiveList,
  sendMediaById,
  sendTemplate,
  markMessageAsRead,
  isServiceWindowOpen,
  sendStaffMessage,
  logIncomingMessage,
  updateDeliveryStatus,
  extractWebhookMessages,
  downloadMetaMedia,
  setMetaFetchForTests
};
