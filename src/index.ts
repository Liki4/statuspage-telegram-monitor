import type { FetchDependencies, QueueEventEnvelope, WorkerEnv } from "./types";
import {
  normalizeStatuspagePayload,
  WebhookValidationError,
} from "./webhook";

const defaultFetchDependencies: FetchDependencies = {
  now: () => new Date(),
};

const encoder = new TextEncoder();

export const MAX_WEBHOOK_BODY_BYTES = 128 * 1024;

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

export async function secureEqual(
  provided: string,
  expected: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([
    sha256Bytes(provided),
    sha256Bytes(expected),
  ]);
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(bytes) && bytes > MAX_WEBHOOK_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new BodyTooLargeError();
  }

  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new InvalidJsonError();
  }
}

export async function handleFetch(
  request: Request,
  env: WorkerEnv,
  deps: FetchDependencies = defaultFetchDependencies,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }
    return jsonResponse(
      { ok: true, service: "statuspage-telegram-worker" },
      200,
    );
  }

  if (url.pathname !== "/webhook") {
    return jsonResponse({ ok: false, error: "not_found" }, 404);
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  const token = url.searchParams.get("token") ?? "";
  if (!(await secureEqual(token, env.WEBHOOK_SECRET))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  let payload: unknown;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
    }
    return jsonResponse({ ok: false, error: "invalid_payload" }, 400);
  }

  try {
    const result = normalizeStatuspagePayload(payload, deps.now().toISOString());
    if (result.kind === "ignored") {
      return jsonResponse(
        { ok: true, queued: false, reason: "unsupported_event" },
        202,
      );
    }

    await env.NOTIFICATION_QUEUE.send(result.envelope, { contentType: "json" });
    return jsonResponse({ ok: true, queued: true }, 202);
  } catch (error) {
    if (error instanceof WebhookValidationError) {
      return jsonResponse({ ok: false, error: "invalid_payload" }, 400);
    }
    return jsonResponse({ ok: false, error: "queue_unavailable" }, 503);
  }
}

export default {
  fetch(
    request: Request,
    env: WorkerEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    return handleFetch(request, env);
  },
} satisfies ExportedHandler<WorkerEnv, QueueEventEnvelope>;
