import type { FetchDependencies, QueueEventEnvelope, WorkerEnv } from "./types";

const defaultFetchDependencies: FetchDependencies = {
  now: () => new Date(),
};

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function handleFetch(
  request: Request,
  _env: WorkerEnv,
  _deps: FetchDependencies = defaultFetchDependencies,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/health") {
    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }
    return jsonResponse(
      { ok: true, service: "statuspage-telegram-worker" },
      200,
    );
  }

  return jsonResponse({ ok: false, error: "not_found" }, 404);
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
