import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  reset,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeRetryDelay,
  handleQueue,
} from "../src/consumer";
import { deliveryKey, fingerprintEvent, hashTarget } from "../src/dedup";
import type {
  QueueEventEnvelope,
  TelegramSendResult,
  TelegramTarget,
} from "../src/types";
import { normalizeStatuspagePayload } from "../src/webhook";
import incidentPayload from "./fixtures/incident.json";

const validConfig = {
  version: 1,
  timezone: "Asia/Shanghai",
  telegram: {
    targets: [
      { chatId: "1001", label: "管理员" },
      { chatId: "-1002002", label: "运维群" },
    ],
  },
  pages: {
    j2mfxwj97wnj: {
      name: "示例服务状态",
      url: "https://status.example.com",
    },
  },
};

const normalized = normalizeStatuspagePayload(
  incidentPayload,
  "2026-08-24T05:00:00.000Z",
);
if (normalized.kind !== "accepted") throw new Error("expected accepted event");
const incidentEnvelope: QueueEventEnvelope = normalized.envelope;

type TestQueueMessage = Parameters<
  typeof createMessageBatch<QueueEventEnvelope>
>[1][number];

function batchFor(
  envelope: QueueEventEnvelope,
  attempts = 1,
  id = "message-1",
) {
  return createMessageBatch<QueueEventEnvelope>("statuspage-telegram-notifications", [
    {
      id,
      timestamp: new Date("2026-08-24T05:00:00.000Z"),
      attempts,
      body: envelope,
    },
  ] satisfies TestQueueMessage[]);
}

function sendResults(...results: TelegramSendResult[]) {
  return vi.fn(async (
    _botToken: string,
    _target: TelegramTarget,
    _text: string,
  ): Promise<TelegramSendResult> => results.shift() ?? { ok: true });
}

async function queueResult(batch: MessageBatch<QueueEventEnvelope>) {
  return getQueueResult(batch, createExecutionContext());
}

async function expectAck(batch: MessageBatch<QueueEventEnvelope>, id = "message-1") {
  await expect(queueResult(batch)).resolves.toMatchObject({
    explicitAcks: [id],
    retryMessages: [],
  });
}

async function expectRetry(batch: MessageBatch<QueueEventEnvelope>, id = "message-1") {
  await expect(queueResult(batch)).resolves.toMatchObject({
    explicitAcks: [],
    retryMessages: [expect.objectContaining({ msgId: id })],
  });
}

async function putValidConfig() {
  await env.STATUSPAGE_KV.put("config", JSON.stringify(validConfig));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("computeRetryDelay", () => {
  it("uses bounded exponential backoff and Telegram retry-after", () => {
    expect(computeRetryDelay(1, [])).toBe(15);
    expect(computeRetryDelay(2, [])).toBe(30);
    expect(computeRetryDelay(10, [])).toBe(900);
    expect(
      computeRetryDelay(1, [
        { ok: false, kind: "http", status: 429, description: "rate", retryAfter: 37 },
      ]),
    ).toBe(37);
    expect(
      computeRetryDelay(1, [
        { ok: false, kind: "http", status: 429, description: "rate", retryAfter: 7200 },
      ]),
    ).toBe(3600);
  });
});

describe("handleQueue", () => {
  it("fans out successful deliveries, records them, and explicitly acknowledges", async () => {
    await putValidConfig();
    const sendTelegram = sendResults({ ok: true, messageId: 11 }, { ok: true, messageId: 12 });
    const batch = batchFor(incidentEnvelope);

    await handleQueue(batch, env, { sendTelegram, log: vi.fn(), now: () => new Date("2026-08-24T06:00:00.000Z") });

    expect(sendTelegram).toHaveBeenCalledTimes(2);
    const fingerprint = await fingerprintEvent(incidentEnvelope.event);
    for (const target of validConfig.telegram.targets) {
      const key = deliveryKey(fingerprint, await hashTarget(target.chatId));
      await expect(env.STATUSPAGE_KV.get(key, "json")).resolves.toMatchObject({ sentAt: "2026-08-24T06:00:00.000Z" });
    }
    await expectAck(batch);
  });

  it("skips recorded targets and acknowledges after the remaining targets succeed", async () => {
    await putValidConfig();
    const fingerprint = await fingerprintEvent(incidentEnvelope.event);
    await env.STATUSPAGE_KV.put(
      deliveryKey(fingerprint, await hashTarget("1001")),
      JSON.stringify({ sentAt: "2026-08-24T05:00:00.000Z" }),
    );
    const sendTelegram = sendResults({ ok: true });
    const batch = batchFor(incidentEnvelope);

    await handleQueue(batch, env, { sendTelegram, log: vi.fn(), now: () => new Date() });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls[0][1]).toMatchObject({ chatId: "-1002002" });
    await expectAck(batch);
  });

  it("records successful targets and retries unresolved targets", async () => {
    await putValidConfig();
    const sendTelegram = sendResults(
      { ok: true, messageId: 11 },
      { ok: false, kind: "http", status: 500, description: "server" },
    );
    const batch = batchFor(incidentEnvelope);

    await handleQueue(batch, env, { sendTelegram, log: vi.fn(), now: () => new Date() });

    const fingerprint = await fingerprintEvent(incidentEnvelope.event);
    await expect(env.STATUSPAGE_KV.get(deliveryKey(fingerprint, await hashTarget("1001")))).resolves.not.toBeNull();
    await expectRetry(batch);
  });

  it("only sends unresolved targets when retried after partial success", async () => {
    await putValidConfig();
    const fingerprint = await fingerprintEvent(incidentEnvelope.event);
    await env.STATUSPAGE_KV.put(
      deliveryKey(fingerprint, await hashTarget("1001")),
      JSON.stringify({ sentAt: "2026-08-24T05:00:00.000Z" }),
    );
    const sendTelegram = sendResults({ ok: true });
    const batch = batchFor(incidentEnvelope, 2);

    await handleQueue(batch, env, { sendTelegram, log: vi.fn(), now: () => new Date() });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls[0][1]).toMatchObject({ chatId: "-1002002" });
    await expectAck(batch);
  });

  it("retries Telegram rate limits using the bounded Telegram delay", async () => {
    await putValidConfig();
    const sendTelegram = sendResults({ ok: false, kind: "http", status: 429, description: "rate", retryAfter: 37 });
    const log = vi.fn();
    const batch = batchFor(incidentEnvelope);

    await handleQueue(batch, env, { sendTelegram, log, now: () => new Date() });

    expect(computeRetryDelay(1, [{ ok: false, kind: "http", status: 429, description: "rate", retryAfter: 37 }])).toBe(37);
    await expectRetry(batch);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      action: "retry",
      delaySeconds: 37,
    }));
  });

  it("retries without Telegram delivery for missing or invalid configuration", async () => {
    for (const config of [undefined, { version: 2 }]) {
      await reset();
      if (config !== undefined) {
        await env.STATUSPAGE_KV.put("config", JSON.stringify(config));
      }
      const sendTelegram = sendResults({ ok: true });
      const batch = batchFor(incidentEnvelope);

      await handleQueue(batch, env, { sendTelegram, log: vi.fn(), now: () => new Date() });

      expect(sendTelegram).not.toHaveBeenCalled();
      await expectRetry(batch);
    }
  });

  it("retries without Telegram delivery when KV config reads fail", async () => {
    await putValidConfig();
    const sendTelegram = sendResults({ ok: true });
    vi.spyOn(env.STATUSPAGE_KV, "get").mockRejectedValueOnce(new Error("kv unavailable"));
    const batch = batchFor(incidentEnvelope);

    await handleQueue(batch, env, { sendTelegram, log: vi.fn(), now: () => new Date() });

    expect(sendTelegram).not.toHaveBeenCalled();
    await expectRetry(batch);
  });

  it("retries when recording a successful delivery fails", async () => {
    await putValidConfig();
    const sendTelegram = sendResults({ ok: true, messageId: 11 }, { ok: true, messageId: 12 });
    vi.spyOn(env.STATUSPAGE_KV, "put").mockRejectedValueOnce(new Error("kv unavailable"));
    const batch = batchFor(incidentEnvelope);

    await handleQueue(batch, env, { sendTelegram, log: vi.fn(), now: () => new Date() });

    expect(sendTelegram).toHaveBeenCalledTimes(2);
    await expectRetry(batch);
  });

  it("decides each message in a batch independently", async () => {
    await putValidConfig();
    const failedEnvelope = structuredClone(incidentEnvelope);
    if (failedEnvelope.event.type === "incident") {
      failedEnvelope.event.incident.id = "different-incident";
      failedEnvelope.event.page.id = "failed-page";
    }
    const batch = createMessageBatch<QueueEventEnvelope>("statuspage-telegram-notifications", [
      { id: "acknowledge", timestamp: new Date(), attempts: 1, body: incidentEnvelope },
      { id: "retry", timestamp: new Date(), attempts: 1, body: failedEnvelope },
    ] satisfies TestQueueMessage[]);
    const sendTelegram = vi.fn(async (
      _botToken: string,
      _target: TelegramTarget,
      text: string,
    ): Promise<TelegramSendResult> => text.includes("failed-page")
      ? { ok: false, kind: "network", description: "network" }
      : { ok: true });

    await handleQueue(batch, env, { sendTelegram, log: vi.fn(), now: () => new Date() });

    await expect(queueResult(batch)).resolves.toMatchObject({
      explicitAcks: ["acknowledge"],
      retryMessages: [expect.objectContaining({ msgId: "retry" })],
    });
  });

  it("emits redacted structured operational logs", async () => {
    await putValidConfig();
    const log = vi.fn();
    const batch = batchFor(incidentEnvelope);

    await handleQueue(batch, env, {
      sendTelegram: sendResults({ ok: true }, { ok: true }),
      log,
      now: () => new Date(),
    });

    expect(log).toHaveBeenCalled();
    const serialized = JSON.stringify(log.mock.calls.map(([entry]) => entry));
    expect(serialized).toContain("eventType");
    expect(serialized).toContain("pageId");
    expect(serialized).toContain("fingerprint");
    expect(serialized).toContain("messageId");
    expect(serialized).toContain("attempt");
    expect(serialized).toContain("action");
    expect(serialized).toMatch(/target(Label|Hash)/);
    expect(serialized).not.toContain("test-bot-token");
    expect(serialized).not.toContain("1001");
    expect(serialized).not.toContain("-1002002");
  });
});
