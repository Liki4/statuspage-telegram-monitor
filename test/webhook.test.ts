import { describe, expect, it } from "vitest";
import componentPayload from "./fixtures/component-update.json";
import incidentPayload from "./fixtures/incident.json";
import {
  WebhookValidationError,
  normalizeStatuspagePayload,
} from "../src/webhook";

const receivedAt = "2026-08-24T05:00:00.000Z";

describe("normalizeStatuspagePayload", () => {
  it("normalizes an incident and selects the newest update by timestamp", () => {
    const result = normalizeStatuspagePayload(incidentPayload, receivedAt);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted" || result.envelope.event.type !== "incident") {
      throw new Error("expected incident event");
    }
    expect(result.envelope.version).toBe(1);
    expect(result.envelope.receivedAt).toBe(receivedAt);
    expect(result.envelope.event.page).toEqual({
      id: "j2mfxwj97wnj",
      statusIndicator: "critical",
      statusDescription: "Major System Outage",
    });
    expect(result.envelope.event.incident.latestUpdate?.id).toBe("latest-update");
    expect(result.envelope.event.incident.name).toBe("Virginia Is Down");
  });

  it("normalizes a component status transition", () => {
    const result = normalizeStatuspagePayload(componentPayload, receivedAt);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted" || result.envelope.event.type !== "component") {
      throw new Error("expected component event");
    }
    expect(result.envelope.event.component.name).toBe("Some Component");
    expect(result.envelope.event.update).toEqual({
      id: "k7730b5v92bv",
      oldStatus: "major_outage",
      newStatus: "operational",
      createdAt: "2026-08-24T04:30:00Z",
    });
  });

  it("rejects a missing page id", () => {
    expect(() =>
      normalizeStatuspagePayload({ page: {}, incident: {} }, receivedAt),
    ).toThrow(WebhookValidationError);
  });

  it("uses the final update only when all update timestamps are invalid", () => {
    const result = normalizeStatuspagePayload(
      {
        meta: { unsubscribe: "secret" },
        page: { id: "page-id" },
        incident: {
          id: "incident-id",
          incident_updates: [
            { id: "first", display_at: "not-a-date" },
            { id: "final", created_at: "also-not-a-date" },
          ],
        },
      },
      receivedAt,
    );
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted" || result.envelope.event.type !== "incident") {
      throw new Error("expected incident event");
    }
    expect(result.envelope.event.incident.latestUpdate?.id).toBe("final");
    expect(JSON.stringify(result.envelope)).not.toContain("unsubscribe");
    expect(JSON.stringify(result.envelope)).not.toContain("incident_updates");
  });

  it("acknowledges an unsupported authenticated payload as ignored", () => {
    expect(
      normalizeStatuspagePayload(
        { page: { id: "page-id" }, future_event: { id: "1" } },
        receivedAt,
      ),
    ).toEqual({ kind: "ignored", reason: "unsupported_event" });
  });
});
