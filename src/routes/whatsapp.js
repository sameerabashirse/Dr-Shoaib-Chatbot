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
  markMessageAsRead
} = require("../services/whatsappService");
const { handleIncomingMessage } = require("../conversation/orchestrator");
const { ConversationSession, WhatsAppMessage, Patient } = require("../models");
const { requireAuth } = require("../middleware/auth");
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
  // express-mongo-sanitize replaces dots in query keys with underscores.
  // Accept both Meta's original names and their sanitized equivalents.
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
    console.warn("WhatsApp webhook rejected.", { requestId: req.requestId, reason: "invalid_signature" });
    throw forbidden("Invalid Meta webhook signature.");
  }

  const { messages, statuses } = extractWebhookMessages(req.body);
  console.log("WhatsApp webhook accepted.", {
    requestId: req.requestId,
    messageCount: messages.length,
    statusCount: statuses.length
  });
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
      if (message.body) {
        await markMessageAsRead(message.metaMessageId).catch(() => undefined);
        const reply = await handleIncomingMessage({ phoneE164: message.phoneE164, text: message.body, replyId: message.replyId });
        if (reply?.kind === "buttons") await sendReplyButtons(message.phoneE164, reply.body, reply.buttons);
        else if (reply?.kind === "list") await sendInteractiveList(message.phoneE164, reply.body, reply.buttonText, reply.sections);
        else if (reply?.body) await sendText(message.phoneE164, reply.body);
      }
    })().catch((error) => console.error("WhatsApp processing failed", { requestId: req.requestId, name: error.name })));
  }
  res.json({ success: true });
  void Promise.allSettled(pending);
}));

// Simulate incoming WhatsApp message from patient interface
router.post("/simulate-message", publicFormLimiter, asyncHandler(async (req, res) => {
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
      lastMessageAt: new Date()
    });
  }

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
    language: input.language || session.language
  });

  // Save AI outgoing message
  const outgoingMsg = await WhatsAppMessage.create({
    phoneE164,
    conversation: session._id,
    direction: "outgoing",
    senderType: "ai",
    body: reply?.body || reply?.text || "Thank you. Dr. Sohaib's assistant is processing your request.",
    status: "delivered"
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
router.get("/conversations", requireAuth, asyncHandler(async (req, res) => {
  const conversations = await ConversationSession.find()
    .populate("patient takenOverBy")
    .sort({ humanRequired: -1, lastMessageAt: -1 })
    .limit(200)
    .lean();
  res.json({ success: true, conversations });
}));

// Get messages for specific phone
router.get("/conversations/:phone/messages", requireAuth, asyncHandler(async (req, res) => {
  const phoneE164 = normalizePhone(req.params.phone) || req.params.phone;
  const messages = await WhatsAppMessage.find({ phoneE164 })
    .populate("senderStaff", "name role")
    .sort({ createdAt: 1 })
    .limit(200)
    .lean();
  res.json({ success: true, messages });
}));

// Human takeover (Pause AI)
router.post("/conversations/:phone/takeover", requireAuth, asyncHandler(async (req, res) => {
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
router.post("/conversations/:phone/reactivate-ai", requireAuth, asyncHandler(async (req, res) => {
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
router.post("/conversations/:phone/send", requireAuth, asyncHandler(async (req, res) => {
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

  const outgoingMsg = await WhatsAppMessage.create({
    phoneE164,
    conversation: session._id,
    direction: "outgoing",
    senderType: "staff",
    senderStaff: req.user._id,
    body: input.message,
    status: "delivered"
  });

  session.lastMessageAt = new Date();
  await session.save();

  await audit({ actorType: "staff", actorStaff: req.user._id, action: "conversation.staff_message_sent", entityType: "conversation", entityId: phoneE164, req });
  res.json({ success: true, message: outgoingMsg });
}));

module.exports = router;
