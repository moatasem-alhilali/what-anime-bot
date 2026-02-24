import { z } from "zod";
import { fetchWithTimeout, logError, safeJson, trimForTelegram } from "../lib/utils.js";
import { downloadFileBuffer, getFile, sendMessage, sendPhoto, sendVideo } from "../lib/telegram.js";

const TRACE_SEARCH_URL = "https://api.trace.moe/search?anilistInfo";
const MAX_RESULTS = 3;
const MAX_IMAGE_SIZE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_SIZE_MB = Math.floor(MAX_IMAGE_SIZE_BYTES / (1024 * 1024));
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 15_000;
const TRACE_TIMEOUT_MS = 15_000;

const NO_IMAGE_MESSAGE = "يرجى إرسال لقطة شاشة كصورة لمعرفة اسم الأنمي.";
const IMAGE_TOO_LARGE_MESSAGE = `الصورة كبيرة جدًا. الحد الأقصى المسموح هو ${MAX_IMAGE_SIZE_MB} ميجابايت.`;
const TELEGRAM_DOWNLOAD_ERROR_MESSAGE =
  "تعذر تنزيل الصورة من تيليجرام. أعد إرسال الصورة مرة أخرى.";
const TRACE_API_ERROR_MESSAGE =
  "تعذر الوصول إلى خدمة التعرف على الأنمي حاليًا. حاول مرة أخرى لاحقًا.";
const TRACE_RESPONSE_ERROR_MESSAGE =
  "وصلت استجابة غير متوقعة من خدمة التعرف على الأنمي. جرّب صورة أوضح.";
const TIMEOUT_ERROR_MESSAGE =
  "انتهت مهلة المعالجة. جرّب مرة أخرى بصورة أصغر أو أوضح.";
const NO_RESULTS_MESSAGE =
  "لم يتم العثور على نتائج مناسبة. جرّب لقطة أوضح من نفس المشهد.";
const PREVIEW_SEND_FAILED_MESSAGE = "تعذر إرسال المعاينة المرئية لهذه النتيجة.";
const GENERIC_ERROR_MESSAGE = "حدث خطأ غير متوقع أثناء تحليل الصورة. حاول لاحقًا.";
const SUCCESS_HEADER = "نتائج البحث عن الأنمي 🔍";

const TelegramPhotoSchema = z
  .object({
    file_id: z.string().min(1),
    file_size: z.number().int().nonnegative().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .passthrough();

const TelegramMessageSchema = z
  .object({
    chat: z.object({
      id: z.union([z.number(), z.string()]),
    }),
    text: z.string().optional(),
    caption: z.string().optional(),
    photo: z.array(TelegramPhotoSchema).optional(),
  })
  .passthrough();

const TelegramUpdateSchema = z
  .object({
    update_id: z.number().optional(),
    message: TelegramMessageSchema.optional(),
    edited_message: TelegramMessageSchema.optional(),
    channel_post: TelegramMessageSchema.optional(),
  })
  .passthrough();

class ProcessingError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "ProcessingError";
    this.code = code;
    this.cause = cause;
  }
}

function getIncomingMessage(update) {
  return update.message || update.edited_message || update.channel_post || null;
}

function isTimeoutError(error) {
  if (error?.name === "AbortError") {
    return true;
  }

  const message = String(error?.message || "").toLowerCase();
  return message.includes("timeout");
}

function getPhotoSortWeight(photo) {
  if (typeof photo?.file_size === "number" && Number.isFinite(photo.file_size)) {
    return photo.file_size;
  }

  const width = Number.isFinite(photo?.width) ? photo.width : 0;
  const height = Number.isFinite(photo?.height) ? photo.height : 0;
  return width * height;
}

function getLargestPhoto(photos) {
  if (!Array.isArray(photos) || photos.length === 0) {
    return null;
  }

  return photos.reduce((largest, candidate) => {
    if (!largest) {
      return candidate;
    }

    return getPhotoSortWeight(candidate) >= getPhotoSortWeight(largest)
      ? candidate
      : largest;
  }, null);
}

function formatTimestamp(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "--:--";
  }

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function pickAnimeTitle(result) {
  const title = result?.anilist?.title;
  if (title && typeof title === "object") {
    return title.romaji || title.english || title.native || null;
  }

  if (typeof result?.filename === "string" && result.filename.trim()) {
    return result.filename.trim();
  }

  return null;
}

function formatEpisode(episode) {
  if (typeof episode === "number" && Number.isFinite(episode)) {
    return String(episode);
  }

  if (typeof episode === "string" && episode.trim()) {
    return episode.trim();
  }

  return "غير متوفر";
}

function formatSimilarity(similarity) {
  if (typeof similarity !== "number" || !Number.isFinite(similarity)) {
    return "غير متوفر";
  }

  return `${(similarity * 100).toFixed(2)}%`;
}

function normalizePreviewUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (!/^https?:\/\//i.test(normalized)) {
    return null;
  }

  return normalized;
}

function formatTraceResultDetails(result, index) {
  const title = pickAnimeTitle(result) || "غير متوفر";
  const from = formatTimestamp(result?.from);
  const to = formatTimestamp(result?.to);
  const lines = [
    `النتيجة ${index}`,
    `العنوان: ${title}`,
    `الحلقة: ${formatEpisode(result?.episode)}`,
    `نسبة التشابه: ${formatSimilarity(result?.similarity)}`,
    `الوقت: ${from} → ${to}`,
  ];

  return lines.join("\n");
}

async function sendResultPreview(token, chatId, result, index) {
  const details = formatTraceResultDetails(result, index);
  const imageUrl = normalizePreviewUrl(result?.image);
  const videoUrl = normalizePreviewUrl(result?.video);
  let sent = false;

  if (imageUrl) {
    try {
      await sendPhoto(token, {
        chatId,
        photoUrl: imageUrl,
        caption: details,
      });
      sent = true;
    } catch (error) {
      logError("Failed to send preview image", error, { chatId, index, imageUrl });
    }
  }

  if (videoUrl) {
    try {
      await sendVideo(token, {
        chatId,
        videoUrl,
        caption: sent ? "" : details,
      });
      sent = true;
    } catch (error) {
      logError("Failed to send preview video", error, { chatId, index, videoUrl });
    }
  }

  if (!sent) {
    await safeReply(
      token,
      chatId,
      trimForTelegram(`${details}\n${PREVIEW_SEND_FAILED_MESSAGE}`, 3900),
    );
  }
}

async function parseBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === "string") {
    return JSON.parse(req.body);
  }

  if (Buffer.isBuffer(req.body)) {
    return JSON.parse(req.body.toString("utf8"));
  }

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }

  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

async function safeReply(token, chatId, text) {
  try {
    await sendMessage(token, { chatId, text });
  } catch (error) {
    logError("Failed to send Telegram message", error, { chatId });
  }
}

async function sendErrorByType(token, chatId, error) {
  if (error instanceof ProcessingError) {
    if (error.code === "IMAGE_TOO_LARGE") {
      await safeReply(token, chatId, IMAGE_TOO_LARGE_MESSAGE);
      return;
    }

    if (error.code === "TELEGRAM_DOWNLOAD_FAILED") {
      await safeReply(token, chatId, TELEGRAM_DOWNLOAD_ERROR_MESSAGE);
      return;
    }

    if (error.code === "TRACE_API_FAILURE") {
      await safeReply(token, chatId, TRACE_API_ERROR_MESSAGE);
      return;
    }

    if (error.code === "TRACE_INVALID_RESPONSE") {
      await safeReply(token, chatId, TRACE_RESPONSE_ERROR_MESSAGE);
      return;
    }

    if (error.code === "TIMEOUT") {
      await safeReply(token, chatId, TIMEOUT_ERROR_MESSAGE);
      return;
    }
  }

  if (isTimeoutError(error)) {
    await safeReply(token, chatId, TIMEOUT_ERROR_MESSAGE);
    return;
  }

  await safeReply(token, chatId, GENERIC_ERROR_MESSAGE);
}

async function downloadTelegramPhoto(token, photo) {
  if (photo.file_size && photo.file_size > MAX_IMAGE_SIZE_BYTES) {
    throw new ProcessingError("IMAGE_TOO_LARGE", "Photo exceeded size limit");
  }

  let fileMeta;
  try {
    fileMeta = await getFile(token, { fileId: photo.file_id });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ProcessingError("TIMEOUT", "Telegram getFile timeout", error);
    }

    throw new ProcessingError("TELEGRAM_DOWNLOAD_FAILED", "Telegram getFile failed", error);
  }

  if (!fileMeta?.file_path) {
    throw new ProcessingError("TELEGRAM_DOWNLOAD_FAILED", "Telegram file path was not returned");
  }

  let buffer;
  try {
    buffer = await downloadFileBuffer(token, {
      filePath: fileMeta.file_path,
      timeoutMs: TELEGRAM_DOWNLOAD_TIMEOUT_MS,
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ProcessingError("TIMEOUT", "Telegram file download timeout", error);
    }

    throw new ProcessingError("TELEGRAM_DOWNLOAD_FAILED", "Telegram file download failed", error);
  }

  if (!buffer || buffer.length === 0) {
    throw new ProcessingError("TELEGRAM_DOWNLOAD_FAILED", "Downloaded image is empty");
  }

  if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
    throw new ProcessingError("IMAGE_TOO_LARGE", "Downloaded image exceeded size limit");
  }

  return buffer;
}

async function searchTraceMoe(imageBuffer) {
  const form = new FormData();
  form.append("image", new Blob([imageBuffer], { type: "image/jpeg" }), "screenshot.jpg");

  let response;
  try {
    response = await fetchWithTimeout(TRACE_SEARCH_URL, {
      method: "POST",
      body: form,
      timeoutMs: TRACE_TIMEOUT_MS,
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ProcessingError("TIMEOUT", "Trace.moe request timeout", error);
    }

    throw new ProcessingError("TRACE_API_FAILURE", "Trace.moe request failed", error);
  }

  if (!response.ok) {
    throw new ProcessingError(
      "TRACE_API_FAILURE",
      `Trace.moe returned non-OK status: ${response.status}`,
    );
  }

  const payload = await safeJson(response);
  if (!payload || !Array.isArray(payload.result)) {
    throw new ProcessingError("TRACE_INVALID_RESPONSE", "Trace.moe payload format was invalid");
  }

  return payload.result.filter((item) => item && typeof item === "object");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }

  const token = process.env.BOT_TOKEN;
  if (!token) {
    logError("Missing BOT_TOKEN", new Error("Missing env variable"));
    res.status(500).json({ ok: false });
    return;
  }

  let chatId = null;

  try {
    const body = await parseBody(req);
    const parsed = TelegramUpdateSchema.safeParse(body);

    if (!parsed.success) {
      logError(
        "Invalid Telegram webhook payload",
        new Error("Validation failed"),
        { issues: parsed.error.issues },
      );
      res.status(400).json({ ok: false });
      return;
    }

    const message = getIncomingMessage(parsed.data);
    chatId = message?.chat?.id ?? null;

    if (!message || chatId === null) {
      res.status(200).json({ ok: true });
      return;
    }

    const photo = getLargestPhoto(message.photo);
    if (!photo) {
      await safeReply(token, chatId, NO_IMAGE_MESSAGE);
      res.status(200).json({ ok: true });
      return;
    }

    const imageBuffer = await downloadTelegramPhoto(token, photo);
    const results = await searchTraceMoe(imageBuffer);

    if (results.length === 0) {
      await safeReply(token, chatId, NO_RESULTS_MESSAGE);
      res.status(200).json({ ok: true });
      return;
    }

    const topResults = results.slice(0, MAX_RESULTS);
    await safeReply(token, chatId, `${SUCCESS_HEADER}\nعدد النتائج: ${topResults.length}`);

    for (let index = 0; index < topResults.length; index += 1) {
      await sendResultPreview(token, chatId, topResults[index], index + 1);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    logError("Failed to process Telegram update", error, { chatId, code: error?.code });

    if (chatId !== null) {
      await sendErrorByType(token, chatId, error);
    }

    res.status(200).json({ ok: true });
  }
}
