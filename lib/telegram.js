import { fetchWithTimeout, safeJson, trimForTelegram } from "./utils.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 12_000;

function buildTelegramMethodUrl(token, method) {
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

function buildTelegramFileUrl(token, filePath) {
  return `${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`;
}

async function callTelegramApi(token, method, { json, formData } = {}) {
  if (!token) {
    throw new Error("Missing Telegram bot token");
  }

  const hasJsonBody = typeof json !== "undefined";
  const response = await fetchWithTimeout(buildTelegramMethodUrl(token, method), {
    method: "POST",
    headers: hasJsonBody ? { "content-type": "application/json" } : undefined,
    body: hasJsonBody ? JSON.stringify(json) : formData,
    timeoutMs: TELEGRAM_TIMEOUT_MS,
  });

  const payload = await safeJson(response);

  if (!response.ok || !payload?.ok) {
    const reason = payload?.description || `HTTP ${response.status}`;
    throw new Error(`Telegram API ${method} failed: ${reason}`);
  }

  return payload.result;
}

export async function sendMessage(token, { chatId, text }) {
  return callTelegramApi(token, "sendMessage", {
    json: {
      chat_id: chatId,
      text: trimForTelegram(text, 3900),
      disable_web_page_preview: true,
    },
  });
}

export async function getFile(token, { fileId }) {
  return callTelegramApi(token, "getFile", {
    json: {
      file_id: fileId,
    },
  });
}

export async function downloadFileBuffer(
  token,
  { filePath, timeoutMs = TELEGRAM_TIMEOUT_MS },
) {
  if (!token) {
    throw new Error("Missing Telegram bot token");
  }

  if (!filePath) {
    throw new Error("Missing Telegram file path");
  }

  const response = await fetchWithTimeout(buildTelegramFileUrl(token, filePath), {
    method: "GET",
    timeoutMs,
  });

  if (!response.ok) {
    throw new Error(`Telegram file download failed: HTTP ${response.status}`);
  }

  const data = await response.arrayBuffer();
  return Buffer.from(data);
}
