import { ConfigError, loadWorkerConfig } from "./config";
import {
  deliveryExists,
  deliveryKey,
  fingerprintEvent,
  hashTarget,
  recordDelivery,
} from "./dedup";
import { formatTelegramMessage } from "./formatter";
import { sendTelegramMessage } from "./telegram";
import type {
  QueueEventEnvelope,
  TelegramSendResult,
  TelegramTarget,
  WorkerEnv,
} from "./types";

export interface ConsumerDependencies {
  sendTelegram: typeof sendTelegramMessage;
  log(entry: Record<string, unknown>): void;
  now(): Date;
}

const defaultDependencies: ConsumerDependencies = {
  sendTelegram: sendTelegramMessage,
  log: (entry) => console.log(JSON.stringify(entry)),
  now: () => new Date(),
};

type TargetResult =
  | { outcome: "sent" | "skipped" }
  | { outcome: "failed"; failure: TelegramSendResult };

function syntheticFailure(description: string): TelegramSendResult {
  return { ok: false, kind: "network", description };
}

function targetContext(target: TelegramTarget, targetHash: string): Record<string, string> {
  return target.label === undefined
    ? { targetHash: targetHash.slice(0, 12) }
    : { targetLabel: target.label };
}

function safeLog(deps: ConsumerDependencies, entry: Record<string, unknown>): void {
  try {
    deps.log(entry);
  } catch {
    // Logging must not affect queue acknowledgement decisions.
  }
}

function sanitizedDescription(
  description: string,
  redactedValues: readonly string[],
): string {
  return redactedValues.reduce(
    (sanitized, value) => sanitized.replaceAll(value, "[redacted]"),
    description,
  ).slice(0, 300);
}

export function computeRetryDelay(
  attempts: number,
  failures: TelegramSendResult[],
): number {
  const retryAfter = failures.reduce(
    (maximum, result) =>
      result.ok || result.retryAfter === undefined
        ? maximum
        : Math.max(maximum, result.retryAfter),
    0,
  );
  if (retryAfter > 0) return Math.min(3600, Math.max(1, retryAfter));
  return Math.min(900, 15 * 2 ** Math.max(0, attempts - 1));
}

function retryMessage(
  message: Message<QueueEventEnvelope>,
  deps: ConsumerDependencies,
  entry: Record<string, unknown>,
  failures: TelegramSendResult[],
): void {
  const delaySeconds = computeRetryDelay(message.attempts, failures);
  try {
    message.retry({ delaySeconds });
  } catch {
    // The queue runtime owns retry state; never propagate a per-message failure.
  }
  safeLog(deps, {
    ...entry,
    action: "retry",
    failureCount: failures.length,
    delaySeconds,
  });
}

async function deliverToTarget(
  target: TelegramTarget,
  fingerprint: string,
  text: string,
  env: WorkerEnv,
  deps: ConsumerDependencies,
  logContext: Record<string, unknown>,
  redactedValues: readonly string[],
): Promise<TargetResult> {
  let targetHash: string;
  try {
    targetHash = await hashTarget(target.chatId);
  } catch {
    return { outcome: "failed", failure: syntheticFailure("consumer_error") };
  }

  const context = { ...logContext, ...targetContext(target, targetHash) };
  const key = deliveryKey(fingerprint, targetHash);
  let exists: boolean;
  try {
    exists = await deliveryExists(env.STATUSPAGE_KV, key);
  } catch {
    safeLog(deps, { ...context, action: "failed", failure: "kv_read_error" });
    return { outcome: "failed", failure: syntheticFailure("kv_read_error") };
  }

  if (exists) {
    safeLog(deps, { ...context, action: "skipped" });
    return { outcome: "skipped" };
  }

  let result: TelegramSendResult;
  try {
    result = await deps.sendTelegram(env.TELEGRAM_BOT_TOKEN, target, text);
  } catch {
    result = syntheticFailure("consumer_error");
  }
  if (!result.ok) {
    safeLog(deps, {
      ...context,
      action: "failed",
      failure: result.kind,
      ...(result.status === undefined ? {} : { telegramStatus: result.status }),
      description: sanitizedDescription(result.description, redactedValues),
    });
    return { outcome: "failed", failure: result };
  }

  try {
    await recordDelivery(env.STATUSPAGE_KV, key, {
      sentAt: deps.now().toISOString(),
      ...(result.messageId === undefined
        ? {}
        : { telegramMessageId: result.messageId }),
    });
  } catch {
    safeLog(deps, { ...context, action: "failed", failure: "kv_write_error" });
    return { outcome: "failed", failure: syntheticFailure("kv_write_error") };
  }

  safeLog(deps, { ...context, action: "sent" });
  return { outcome: "sent" };
}

export async function processQueueMessage(
  message: Message<QueueEventEnvelope>,
  env: WorkerEnv,
  deps: ConsumerDependencies = defaultDependencies,
): Promise<void> {
  const envelope = message.body;
  const initialContext = {
    messageId: message.id,
    attempt: message.attempts,
  };

  try {
    if (envelope.version !== 1) {
      safeLog(deps, { ...initialContext, action: "invalid_envelope" });
      retryMessage(
        message,
        deps,
        initialContext,
        [syntheticFailure("consumer_error")],
      );
      return;
    }

    const logContext = {
      ...initialContext,
      eventType: envelope.event.type,
      pageId: envelope.event.page.id,
    };
    let config;
    try {
      config = await loadWorkerConfig(env.STATUSPAGE_KV);
    } catch (error) {
      retryMessage(
        message,
        deps,
        logContext,
        [syntheticFailure(error instanceof ConfigError ? "config_error" : "kv_read_error")],
      );
      return;
    }

    const pageConfig = config.pages[envelope.event.page.id];
    const text = formatTelegramMessage(envelope.event, pageConfig, config.timezone);
    const fingerprint = await fingerprintEvent(envelope.event);
    const eventContext = { ...logContext, fingerprint };
    const redactedValues = [
      env.TELEGRAM_BOT_TOKEN,
      ...config.telegram.targets.map((target) => target.chatId),
    ];
    const results = await Promise.all(
      config.telegram.targets.map((target) =>
        deliverToTarget(
          target,
          fingerprint,
          text,
          env,
          deps,
          eventContext,
          redactedValues,
        ),
      ),
    );
    const failures = results.flatMap((result) =>
      result.outcome === "failed" ? [result.failure] : [],
    );

    if (failures.length > 0) {
      retryMessage(message, deps, eventContext, failures);
      return;
    }

    try {
      message.ack();
    } catch {
      // The queue runtime owns acknowledgement state; never propagate per-message errors.
    }
    safeLog(deps, { ...eventContext, action: "acknowledged" });
  } catch {
    const eventContext = envelope.version === 1
      ? {
          ...initialContext,
          eventType: envelope.event.type,
          pageId: envelope.event.page.id,
        }
      : initialContext;
    retryMessage(
      message,
      deps,
      eventContext,
      [syntheticFailure("consumer_error")],
    );
  }
}

export async function handleQueue(
  batch: MessageBatch<QueueEventEnvelope>,
  env: WorkerEnv,
  deps: ConsumerDependencies = defaultDependencies,
): Promise<void> {
  await Promise.all(
    batch.messages.map((message) => processQueueMessage(message, env, deps)),
  );
}
