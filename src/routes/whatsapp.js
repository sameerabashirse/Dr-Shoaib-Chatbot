const express = require("express");
const { z } = require("zod");
const { config } = require("../config/env");
const {
  verifyMetaSignature,
  verifyWebhookToken,
  extractWebhookMessages,
  updateDeliveryStatus,
  logIncomingMessage,
  sendText,
  sendReplyButtons,
  sendInteractiveList,
  markMessageAsRead,
  sendStaffMessage
} = require("../services/whatsappService");
const { handleIncomingMessage } = require("../conversation/orchestrator");
const { transcribeWhatsAppVoiceNote } = require("../services/voiceTranscriptionService");
const { storeWhatsAppReport } = require("../services/whatsappReportService");
const { ConversationSession, WhatsAppMessage, Patient } = require("../models");
const { requireAuth } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { webhookLimiter, publicFormLimiter } = require("../middleware/security");
const { asyncHandler } = require("../utils/asyncHandler");
const { badRequest, forbidden, notFound } = require("../utils/errors");
const { audit } = require("../services/auditService");
const { normalizePhone } = require("../utils/security");

const router = express.Router();

function validate(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw badRequest("Validation failed", parsed.error.flatten());
  return parsed.data;
}

// Meta Webhook Verification
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"] || req.query.hub_mode;
  const token = req.query["hub.verify_token"] || req.query.hub_verify_token;
  const challenge = req.query["hub.challenge"] || req.query.hub_challenge;
  if (mode === "subscribe" && verifyWebhookToken(token)) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Meta Webhook Delivery & Incoming
router.post("/webhook", webhookLimiter, asyncHandler(async (req, res) => {
  if (!verifyMetaSignature(req.rawBody, req.get("x-hub-signature-256"))) {
    throw forbidden("Invalid Meta webhook signature.");
  }

  const { messages, statuses } = extractWebhookMessages(req.body);
  const pending = [];
  for (const status of statuses) pending.push(updateDeliveryStatus(status));
  for (const message of messages) {
    pending.push((async () => {
      const logged = await logIncomingMessage({
        metaMessageId: message.metaMessageId,
        phoneE164: message.phoneE164,
        body: message.body,
        messageType: message.type,
        payload: message.payload
      });
      if (logged.duplicate) return;
      await markMessageAsRead(message.metaMessageId).catch(() => undefined);
      if (["document", "image"].includes(message.type) && message.mediaId) {
        const session = await ConversationSession.findOne({ phoneE164: message.phoneE164 });
        if (session?.state !== "AWAITING_REPORT" || !session.context?.appointmentId) {
          await sendText(message.phoneE164, "Please confirm an appointment first, then choose Upload Reports before attaching a PDF, JPEG, or PNG.");
          return;
        }
        try {
          const result = await storeWhatsAppReport({ phone: message.phoneE164, appointmentId: session.context.appointmentId, mediaId: message.mediaId, filename: message.filename });
          await sendReplyButtons(message.phoneE164, `Report received securely. Total reports attached: ${result.reportCount}.`, [
            { id: "AI_REPORTS_ADD", title: "Add Another" }, { id: "AI_REPORTS_DONE", title: "Done" }
          ]);
        } catch {
          await sendText(message.phoneE164, "I couldn’t store that document securely. Please send a valid PDF, JPEG, or PNG within the size limit, or contact reception.");
        }
        return;
      }
      let patientText = message.body;
      let source = "text";
      if (message.type === "audio" && message.mediaId) {
        const transcription = await transcribeWhatsAppVoiceNote(message.mediaId);
        if (!transcription.ok) {
          await sendText(message.phoneE164, "I couldn’t understand that voice note clearly. Please send a shorter voice note or type your request.");
          return;
        }
        patientText = transcription.text;
        source = "voice";
      }
      if (patientText) {
        const reply = await handleIncomingMessage({ phoneE164: message.phoneE164, text: patientText, replyId: message.replyId, messageId: message.metaMessageId, source });
        if (!reply?.notificationQueued) {
          if (reply?.kind === "buttons") await sendReplyButtons(message.phoneE164, reply.body, reply.buttons);
          else if (reply?.kind === "list") await sendInteractiveList(message.phoneE164, reply.body, reply.buttonText, reply.sections);
          else if (reply?.body) await sendText(message.phoneE164, reply.body);
        }
      }
    })().catch((error) => console.error("WhatsApp processing failed", { requestId: req.requestId, name: error.name })));
  }
  res.json({ success: true });
  void Promise.allSettled(pending);
}));

// Simulate incoming WhatsApp message from patient interface
router.post("/simulate-message", requireAuth, requirePermission("conversations.manage"), publicFormLimiter, asyncHandler(async (req, res) => {
  const input = validate(z.object({
    phone: z.string().min(7).max(40),
    message: z.string().min(1).max(2000),
    language: z.enum(["en", "ur"]).optional()
  }), req.body);

  const phoneE164 = normalizePhone(input.phone) || input.phone;
  let session = await ConversationSession.findOne({ phoneE164 });

  if (!session) {
    let patient = await Patient.findOne({ phoneE164 });
    session = await ConversationSession.create({
      phoneE164,
      patient: patient ? patient._id : null,
      language: input.language || "en",
      state: "MAIN_MENU",
      lastMessageAt: new Date()
    });
  }
  session.serviceWindowExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await session.save();

  // Save incoming message
  const incomingMsg = await WhatsAppMessage.create({
    phoneE164,
    conversation: session._id,
    direction: "incoming",
    senderType: "patient",
    body: input.message,
    status: "received"
  });

  // Check if session is taken over by staff
  if (session.aiPaused) {
    session.lastMessageAt = new Date();
    await session.save();
    return res.json({
      success: true,
      humanTakeover: true,
      incomingMessage: incomingMsg,
      reply: { body: "Staff is currently assisting you." }
    });
  }

  // Handle message through AI orchestrator
  const reply = await handleIncomingMessage({
    phoneE164,
    text: input.message,
    language: input.language || session.language,
    messageId: String(incomingMsg._id)
  });

  // Save AI outgoing message
  const outgoingMsg = await WhatsAppMessage.create({
    phoneE164,
    conversation: session._id,
    direction: "outgoing",
    senderType: "ai",
    body: reply?.body || reply?.text || "Thank you. Dr. Sohaib's assistant is processing your request.",
    status: "queued"
  });

  session.lastMessageAt = new Date();
  await session.save();

  res.json({
    success: true,
    incomingMessage: incomingMsg,
    reply: {
      body: outgoingMsg.body,
      buttons: reply?.buttons,
      sections: reply?.sections
    }
  });
}));

// Admin list conversations
router.get("/conversations", requireAuth, requirePermission("conversations.read"), asyncHandler(async (req, res) => {
  const conversations = await ConversationSession.find()
    .populate("patient", "patientId fullName phoneE164 preferredLanguage city")
    .populate("takenOverBy", "name role")
    .sort({ humanRequired: -1, lastMessageAt: -1 })
    .limit(200)
    .lean();
  await audit({ actorType: "staff", action: "whatsapp_conversations.list_viewed", entityType: "conversation", metadata: { resultCount: conversations.length }, req });
  res.json({ success: true, conversations });
}));

// Get messages for specific phone
router.get("/conversations/:phone/messages", requireAuth, requirePermission("conversations.read"), asyncHandler(async (req, res) => {
  const phoneE164 = normalizePhone(req.params.phone) || req.params.phone;
  const messages = await WhatsAppMessage.find({ phoneE164 })
    .populate("senderStaff", "name role")
    .sort({ createdAt: 1 })
    .limit(200)
    .lean();
  await audit({ actorType: "staff", action: "whatsapp_messages.viewed", entityType: "conversation", entityId: phoneE164, metadata: { resultCount: messages.length }, req });
  res.json({ success: true, messages });
}));

// Human takeover (Pause AI)
router.post("/conversations/:phone/takeover", requireAuth, requirePermission("conversations.manage"), asyncHandler(async (req, res) => {
  const phoneE164 = normalizePhone(req.params.phone) || req.params.phone;
  const session = await ConversationSession.findOneAndUpdate(
    { phoneE164 },
    { $set: { aiPaused: true, humanRequired: true, takenOverBy: req.user._id } },
    { new: true, upsert: true }
  );
  await audit({ actorType: "staff", actorStaff: req.user._id, action: "conversation.takeover", entityType: "conversation", entityId: session._id.toString(), req });
  res.json({ success: true, conversation: session });
}));

// Reactivate AI
router.post("/conversations/:phone/reactivate-ai", requireAuth, requirePermission("conversations.manage"), asyncHandler(async (req, res) => {
  const phoneE164 = normalizePhone(req.params.phone) || req.params.phone;
  const session = await ConversationSession.findOne({ phoneE164 });
  if (!session) throw notFound("Conversation was not found.");
  session.aiPaused = false;
  session.humanRequired = false;
  session.takenOverBy = undefined;
  await session.save();
  await audit({ actorType: "staff", actorStaff: req.user._id, action: "conversation.reactivate_ai", entityType: "conversation", entityId: session._id.toString(), req });
  res.json({ success: true, conversation: session });
}));

// Send staff message to patient
router.post("/conversations/:phone/send", requireAuth, requirePermission("conversations.manage"), asyncHandler(async (req, res) => {
  const input = validate(z.object({ message: z.string().min(1).max(4000) }), req.body);
  const phoneE164 = normalizePhone(req.params.phone) || req.params.phone;
  
  let session = await ConversationSession.findOne({ phoneE164 });
  if (!session) {
    session = await ConversationSession.create({
      phoneE164,
      aiPaused: true,
      humanRequired: true,
      takenOverBy: req.user._id
    });
  }

  const result = await sendStaffMessage(phoneE164, input.message, { senderStaff: req.user._id });
  const outgoingMsg = result.message;

  session.lastMessageAt = new Date();
  await session.save();

  await audit({ actorType: "staff", actorStaff: req.user._id, action: result.status === "queued" ? "conversation.staff_message_queued" : "conversation.staff_message_failed", entityType: "conversation", entityId: phoneE164, metadata: { failureCode: result.failureCode }, req });
  if (result.status !== "queued") throw new (require("../utils/errors").AppError)(result.failureCode === "SERVICE_WINDOW_CLOSED" ? 409 : 502, result.failureCode || "WHATSAPP_SEND_FAILED", result.error || "WhatsApp message could not be sent.");
  res.json({ success: true, message: outgoingMsg });
}));

module.exports = router;
