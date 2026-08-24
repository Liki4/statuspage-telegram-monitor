import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleQueue } from "../src/consumer";
import { deliveryKey, fingerprintEvent, hashTarget } from "../src/dedup";
import worker from "../src/index";
import type { QueueEventEnvelope, TelegramTarget } from "../src/types";
import componentPayload from "./fixtures/component-update.json";
import incidentPayload from "./fixtures/incident.json";

const config = {
  version: 1,
  timezone: "Asia/Shanghai",
  telegram: {
    targets: [
      { chatId: "123456789", label: "管理员" },
      { chatId: "-1001234567890", label: "运维群" },
    ],
  },
  pages: {
    j2mfxwj97wnj: {
      name: "示例服务状态",
      url: "https://status.example.com",
    },
  },
} as const;

type TestQueueMessage = Parameters<
  typeof createMessageBatch<QueueEventEnvelope>
>[1][number];

function batchFor(envelope: QueueEventEnvelope, id: string) {
  return createMessageBatch<QueueEventEnvelope>("statuspage-telegram-notifications", [
    {
      id,
      timestamp: new Date("2026-08-24T05:00:00.000Z"),
      attempts: 1,
      body: envelope,
    },
  ] satisfies TestQueueMessage[]);
}

async function queueResult(batch: MessageBatch<QueueEventEnvelope>) {
  return getQueueResult(batch, createExecutionContext());
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("Worker producer-to-consumer fixtures", () => {
  it.each([
    [
      "incident",
      incidentPayload,
      "incident",
      "🔴",
      "<b>重大事件</b>",
      "Virginia Is Down",
      "<b>状态：</b>监控中",
    ],
    [
      "component",
      componentPayload,
      "component",
      "🟠",
      "<b>组件状态更新</b>",
      "Some Component",
      "<b>状态：</b>大面积中断 → 正常",
    ],
  ] as const)("delivers the %s fixture once per target and deduplicates replay", async (
    _name,
    payload,
    eventType,
    severity,
    eventLabel,
    eventText,
    chineseStatus,
  ) => {
    const responses: unknown[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const sent: Array<{ target: TelegramTarget; text: string }> = [];
    const send = vi.spyOn(env.NOTIFICATION_QUEUE, "send").mockResolvedValue({
      metadata: {
        metrics: {
          backlogCount: 0,
          backlogBytes: 0,
          oldestMessageTimestamp: new Date(0),
        },
      },
    });
    await env.STATUSPAGE_KV.put("config", JSON.stringify(config));

    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://status-alerts.example.com/webhook?token=test-webhook-secret", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      context,
    );
    await waitOnExecutionContext(context);
    responses.push(await response.clone().json());

    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
    const envelope = send.mock.calls[0][0] as QueueEventEnvelope;
    expect(envelope).toMatchObject({ version: 1, event: { type: eventType } });

    const firstBatch = batchFor(envelope, `${eventType}-first`);
    await handleQueue(firstBatch, env, {
      sendTelegram: async (_botToken, target, text) => {
        sent.push({ target, text });
        return { ok: true, messageId: sent.length };
      },
      log: (entry) => logs.push(entry),
      now: () => new Date("2026-08-24T06:00:00.000Z"),
    });

    expect(sent).toHaveLength(config.telegram.targets.length);
    expect(sent.map(({ target }) => target.chatId).sort()).toEqual(
      config.telegram.targets.map(({ chatId }) => chatId).sort(),
    );
    for (const { text } of sent) {
      expect(text).toContain(severity);
      expect(text).toContain(eventLabel);
      expect(text).toContain(eventText);
      expect(text).toContain(chineseStatus);
    }
    await expect(queueResult(firstBatch)).resolves.toMatchObject({
      explicitAcks: [`${eventType}-first`],
      retryMessages: [],
    });

    const fingerprint = await fingerprintEvent(envelope.event);
    for (const target of config.telegram.targets) {
      const key = deliveryKey(fingerprint, await hashTarget(target.chatId));
      await expect(env.STATUSPAGE_KV.get(key, "json")).resolves.toMatchObject({
        sentAt: "2026-08-24T06:00:00.000Z",
      });
    }

    const replayBatch = batchFor(envelope, `${eventType}-replay`);
    await handleQueue(replayBatch, env, {
      sendTelegram: async (_botToken, target, text) => {
        sent.push({ target, text });
        return { ok: true, messageId: sent.length };
      },
      log: (entry) => logs.push(entry),
      now: () => new Date("2026-08-24T06:00:00.000Z"),
    });

    expect(sent).toHaveLength(config.telegram.targets.length);
    await expect(queueResult(replayBatch)).resolves.toMatchObject({
      explicitAcks: [`${eventType}-replay`],
      retryMessages: [],
    });

    const serialized = JSON.stringify({ responses, logs });
    expect(serialized).not.toContain("test-bot-token");
    expect(serialized).not.toContain("test-webhook-secret");
    expect(serialized).not.toContain("-1001234567890");
  });
});
