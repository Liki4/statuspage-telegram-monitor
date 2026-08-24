import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { handleFetch, secureEqual } from "../src/index";
import incidentPayload from "./fixtures/incident.json";

const IncomingRequest = Request;

afterEach(() => vi.restoreAllMocks());

async function dispatch(path: string, method = "GET") {
  const request = new IncomingRequest(`https://status-alerts.example.com${path}`, {
    method,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function dispatchWebhook(payload: unknown, token: string) {
  const request = new IncomingRequest(
    `https://status-alerts.example.com/webhook?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const ctx = createExecutionContext();
  const response = await handleFetch(request, env, {
    now: () => new Date("2026-08-24T05:00:00.000Z"),
  });
  await waitOnExecutionContext(ctx);
  return response;
}

describe("base routes", () => {
  it("returns a shallow health response", async () => {
    const response = await dispatch("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "statuspage-telegram-worker",
    });
  });

  it("returns 405 for a non-GET health request", async () => {
    const response = await dispatch("/health", "POST");
    expect(response.status).toBe(405);
  });

  it("returns 404 without redirecting unknown paths", async () => {
    const response = await dispatch("/missing");
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("webhook route", () => {
  it("rejects a missing token without enqueueing", async () => {
    const send = vi.spyOn(env.NOTIFICATION_QUEUE, "send");
    const response = await dispatchWebhook(incidentPayload, "");
    expect(response.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a wrong token without enqueueing", async () => {
    const send = vi.spyOn(env.NOTIFICATION_QUEUE, "send");
    const response = await dispatchWebhook(incidentPayload, "wrong-token");
    expect(response.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 405 for a GET webhook request", async () => {
    const response = await dispatch("/webhook", "GET");
    expect(response.status).toBe(405);
  });

  it("returns 400 for malformed JSON", async () => {
    const request = new IncomingRequest(
      "https://status-alerts.example.com/webhook?token=test-webhook-secret",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
    );
    const response = await handleFetch(request, env);
    expect(response.status).toBe(400);
  });

  it("returns 400 for valid JSON without page.id", async () => {
    const response = await dispatchWebhook({ page: {}, incident: {} }, "test-webhook-secret");
    expect(response.status).toBe(400);
  });

  it("acknowledges an authenticated unsupported payload without enqueueing", async () => {
    const send = vi.spyOn(env.NOTIFICATION_QUEUE, "send");
    const response = await dispatchWebhook(
      { page: { id: "page-id" }, future_event: { id: "1" } },
      "test-webhook-secret",
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      reason: "unsupported_event",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 413 for a body larger than 131072 bytes", async () => {
    const response = await dispatchWebhook("x".repeat(131_073), "test-webhook-secret");
    expect(response.status).toBe(413);
  });

  it("queues a normalized event and returns 202", async () => {
    const send = vi.spyOn(env.NOTIFICATION_QUEUE, "send").mockResolvedValue({
      metadata: {
        metrics: {
          backlogCount: 0,
          backlogBytes: 0,
          oldestMessageTimestamp: new Date(0),
        },
      },
    });
    const response = await dispatchWebhook(incidentPayload, "test-webhook-secret");
    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      version: 1,
      event: { type: "incident", page: { id: "j2mfxwj97wnj" } },
    });
    expect(send.mock.calls[0][1]).toEqual({ contentType: "json" });
  });

  it("returns 503 when Queue publication fails", async () => {
    vi.spyOn(env.NOTIFICATION_QUEUE, "send").mockRejectedValue(new Error("queue down"));
    const response = await dispatchWebhook(incidentPayload, "test-webhook-secret");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("queue down");
  });

  it("returns 404 without logging or echoing a token for an unknown path", async () => {
    const log = vi.spyOn(console, "log");
    const token = "test-webhook-secret";
    const response = await dispatch(`/unknown?token=${token}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(token);
    expect(log).not.toHaveBeenCalled();
  });

  it("compares tokens using fixed-length digests", async () => {
    await expect(secureEqual("same", "same")).resolves.toBe(true);
    await expect(secureEqual("same", "different")).resolves.toBe(false);
  });
});
