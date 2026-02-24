export const FETCH_TIMEOUT_MS = 12_000;

export function trimForTelegram(text, maxLength = 3900) {
  const normalized = String(text || "");
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(maxLength - 1, 0))}…`;
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function fetchWithTimeout(url, init = {}) {
  const { timeoutMs = FETCH_TIMEOUT_MS, ...fetchInit } = init;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...fetchInit,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function logError(message, error, meta = {}) {
  const payload = {
    level: "error",
    message,
    error: error?.message || String(error),
    stack: error?.stack,
    ...meta,
  };

  console.error(JSON.stringify(payload));
}

export async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
