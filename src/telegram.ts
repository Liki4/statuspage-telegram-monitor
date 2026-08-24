import type {
  TelegramSendResult,
  TelegramTarget,
} from "./types";

interface TelegramApiResponse {
  ok?: unknown;
  result?: { message_id?: unknown };
  description?: unknown;
  parameters?: { retry_after?: unknown };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getDescription(payload: TelegramApiResponse, status: number): string {
  return typeof payload.description === "string"
    ? payload.description.slice(0, 300)
    : `telegram_http_${status}`;
}

function getRetryAfter(payload: TelegramApiResponse): number | undefined {
  const retryAfter = payload.parameters?.retry_after;
  return typeof retryAfter === "number" &&
    Number.isInteger(retryAfter) &&
    retryAfter >= 1 &&
    retryAfter <= 86400
    ? retryAfter
    : undefined;
}

export async function sendTelegramMessage(
  botToken: string,
  target: TelegramTarget,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramSendResult> {
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: target.chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
    });
  } catch {
    return {
      ok: false,
      kind: "network",
      description: "telegram_network_error",
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      kind: "invalid_response",
      status: response.status,
      description: "telegram_invalid_response",
    };
  }

  if (!isObject(parsed)) {
    return {
      ok: false,
      kind: "invalid_response",
      status: response.status,
      description: "telegram_invalid_response",
    };
  }

  const payload = parsed as TelegramApiResponse;
  if (response.ok && payload.ok === true) {
    const messageId = payload.result?.message_id;
    return typeof messageId === "number" && Number.isInteger(messageId)
      ? { ok: true, messageId }
      : { ok: true };
  }

  const retryAfter = getRetryAfter(payload);
  return {
    ok: false,
    kind: "http",
    status: response.status,
    description: getDescription(payload, response.status),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}
