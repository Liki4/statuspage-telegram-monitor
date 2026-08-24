import type {
  DeliveryRecord,
  NormalizedStatuspageEvent,
} from "./types";

export const DELIVERY_TTL_SECONDS = 7 * 24 * 60 * 60;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function fingerprintEvent(
  event: NormalizedStatuspageEvent,
): Promise<string> {
  if (
    event.type === "incident" &&
    event.incident.id !== undefined &&
    event.incident.latestUpdate?.id !== undefined
  ) {
    return sha256Hex(
      `incident:${event.page.id}:${event.incident.id}:${event.incident.latestUpdate.id}`,
    );
  }

  if (event.type === "component" && event.update.id !== undefined) {
    return sha256Hex(`component:${event.page.id}:${event.update.id}`);
  }

  return sha256Hex(JSON.stringify(stableValue(event)));
}

export async function hashTarget(chatId: string): Promise<string> {
  return sha256Hex(chatId);
}

export function deliveryKey(fingerprint: string, targetHash: string): string {
  return `delivery:v1:${fingerprint}:${targetHash}`;
}

export async function deliveryExists(
  kv: KVNamespace,
  key: string,
): Promise<boolean> {
  return (await kv.get(key)) !== null;
}

export async function recordDelivery(
  kv: KVNamespace,
  key: string,
  record: DeliveryRecord,
): Promise<void> {
  await kv.put(key, JSON.stringify(record), {
    expirationTtl: DELIVERY_TTL_SECONDS,
  });
}
