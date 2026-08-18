const { config } = require("../config/env");
const { downloadMetaMedia } = require("./whatsappService");
const { logError } = require("../utils/safeLogger");

const AUDIO_MIME_TYPES = ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/amr", "audio/aac", "audio/wav", "audio/webm"];
let client;

function getClient() {
  if (!config.aiConcierge.apiKey) return null;
  if (!client) {
    const OpenAI = require("openai");
    client = new OpenAI({ apiKey: config.aiConcierge.apiKey, timeout: config.aiConcierge.timeoutMs, maxRetries: config.aiConcierge.maxRetries });
  }
  return client;
}

async function transcribeWhatsAppVoiceNote(mediaId, options = {}) {
  const openai = options.client || getClient();
  if (!openai) return { ok: false, code: "TRANSCRIPTION_NOT_CONFIGURED" };
  const startedAt = Date.now();
  try {
    const media = await (options.downloadMedia || downloadMetaMedia)(mediaId, {
      maxBytes: config.aiConcierge.maxAudioBytes,
      allowedMimeTypes: AUDIO_MIME_TYPES
    });
    const { toFile } = require("openai");
    const extension = media.mimeType === "audio/ogg" ? "ogg" : media.mimeType.split("/")[1].replace("mpeg", "mp3");
    const transcription = await openai.audio.transcriptions.create({
      model: config.aiConcierge.transcriptionModel,
      file: await toFile(media.buffer, `voice-note.${extension}`, { type: media.mimeType }),
      response_format: "json",
      include: ["logprobs"],
      prompt: "Clinic appointment request in English, Urdu, or Roman Urdu. Preserve names, dates, times, and appointment IDs exactly."
    });
    const text = String(transcription.text || "").trim().slice(0, 2000);
    console.info("Voice note transcription completed.", { latencyMs: Date.now() - startedAt, audioBytes: media.fileSize, transcriptCharacters: text.length });
    if (text.length < 2) return { ok: false, code: "TRANSCRIPTION_UNCLEAR" };
    const logprobs = Array.isArray(transcription.logprobs) ? transcription.logprobs.map((item) => Number(item.logprob)).filter(Number.isFinite) : [];
    if (logprobs.length) {
      const averageConfidence = logprobs.reduce((sum, value) => sum + Math.exp(value), 0) / logprobs.length;
      if (averageConfidence < 0.55) return { ok: false, code: "TRANSCRIPTION_UNCLEAR" };
    }
    return { ok: true, text };
  } catch (error) {
    logError("Voice note transcription failed", error, { latencyMs: Date.now() - startedAt });
    return { ok: false, code: "TRANSCRIPTION_FAILED" };
  }
}

module.exports = { AUDIO_MIME_TYPES, transcribeWhatsAppVoiceNote, setTranscriptionClientForTests(value) { client = value; } };
