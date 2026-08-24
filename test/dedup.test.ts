import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedIncidentEvent } from "../src/types";
import { normalizeStatuspagePayload } from "../src/webhook";
import incidentPayload from "./fixtures/incident.json";
import {
  DELIVERY_TTL_SECONDS,
  deliveryExists,
  deliveryKey,
  fingerprintEvent,
  hashTarget,
  recordDelivery,
} from "../src/dedup";

const normalized = normalizeStatuspagePayload(
  incidentPayload,
  "2026-08-24T05:00:00.000Z",
);
if (normalized.kind !== "accepted" || normalized.envelope.event.type !== "incident") {
  throw new Error("expected normalized incident");
}
const incidentEvent: NormalizedIncidentEvent = normalized.envelope.event;

afterEach(async () => reset());

describe("event fingerprints", () => {
  it("is stable for the same incident update and changes for another update", async () => {
    const first = await fingerprintEvent(incidentEvent);
    const same = await fingerprintEvent(structuredClone(incidentEvent));
    const changed = structuredClone(incidentEvent);
    changed.incident.latestUpdate = {
      ...changed.incident.latestUpdate,
      id: "different-update",
    };
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(same).toBe(first);
    expect(await fingerprintEvent(changed)).not.toBe(first);
  });

  it("hashes targets and never exposes the chat id in the key", async () => {
    const target = await hashTarget("-1001234567890");
    const key = deliveryKey("a".repeat(64), target);
    expect(target).toMatch(/^[a-f0-9]{64}$/);
    expect(key).toBe(`delivery:v1:${"a".repeat(64)}:${target}`);
    expect(key).not.toContain("-1001234567890");
  });

  it("uses a stable fallback when primary ids are absent", async () => {
    const withoutPrimaryIds = structuredClone(incidentEvent);
    delete withoutPrimaryIds.incident.id;
    delete withoutPrimaryIds.incident.latestUpdate?.id;

    const reordered: NormalizedIncidentEvent = {
      type: withoutPrimaryIds.type,
      incident: Object.fromEntries(
        Object.entries(withoutPrimaryIds.incident).reverse(),
      ) as NormalizedIncidentEvent["incident"],
      page: Object.fromEntries(
        Object.entries(withoutPrimaryIds.page).reverse(),
      ) as NormalizedIncidentEvent["page"],
    };

    expect(await fingerprintEvent(reordered)).toBe(
      await fingerprintEvent(withoutPrimaryIds),
    );
  });
});

describe("delivery records", () => {
  it("records successful delivery for seven days", async () => {
    const key = "delivery:v1:event:target";
    expect(await deliveryExists(env.STATUSPAGE_KV, key)).toBe(false);
    await recordDelivery(env.STATUSPAGE_KV, key, {
      sentAt: "2026-08-24T05:30:00.000Z",
      telegramMessageId: 42,
    });
    expect(await deliveryExists(env.STATUSPAGE_KV, key)).toBe(true);
    await expect(env.STATUSPAGE_KV.get(key, "json")).resolves.toEqual({
      sentAt: "2026-08-24T05:30:00.000Z",
      telegramMessageId: 42,
    });
    expect(DELIVERY_TTL_SECONDS).toBe(604800);
  });
});
