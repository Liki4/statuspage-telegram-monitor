import type {
  NormalizedIncidentUpdate,
  QueueEventEnvelope,
} from "./types";

export class WebhookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookValidationError";
  }
}

export type NormalizationResult =
  | { kind: "accepted"; envelope: QueueEventEnvelope }
  | { kind: "ignored"; reason: "unsupported_event" };

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function field(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

function normalizeIncidentUpdate(
  value: Record<string, unknown>,
): NormalizedIncidentUpdate {
  return {
    ...field("id", stringOrUndefined(value.id)),
    ...field("body", stringOrUndefined(value.body)),
    ...field("status", stringOrUndefined(value.status)),
    ...field("displayAt", stringOrUndefined(value.display_at)),
    ...field("createdAt", stringOrUndefined(value.created_at)),
    ...field("updatedAt", stringOrUndefined(value.updated_at)),
  };
}

function timestamp(update: NormalizedIncidentUpdate): number | undefined {
  for (const candidate of [
    update.displayAt,
    update.createdAt,
    update.updatedAt,
  ]) {
    if (candidate === undefined) continue;
    const value = Date.parse(candidate);
    if (!Number.isNaN(value)) return value;
  }
  return undefined;
}

function latestIncidentUpdate(value: unknown): NormalizedIncidentUpdate | undefined {
  if (!Array.isArray(value)) return undefined;

  const updates = value
    .map(objectOrUndefined)
    .filter((update): update is Record<string, unknown> => update !== undefined)
    .map(normalizeIncidentUpdate);
  if (updates.length === 0) return undefined;

  let newest: NormalizedIncidentUpdate | undefined;
  let newestTimestamp: number | undefined;
  for (const update of updates) {
    const updateTimestamp = timestamp(update);
    if (updateTimestamp === undefined) continue;
    if (newest === undefined || newestTimestamp === undefined || updateTimestamp > newestTimestamp) {
      newest = update;
      newestTimestamp = updateTimestamp;
    }
  }
  return newest ?? updates[updates.length - 1];
}

export function normalizeStatuspagePayload(
  payload: unknown,
  receivedAt: string,
): NormalizationResult {
  const root = objectOrUndefined(payload);
  if (root === undefined) {
    throw new WebhookValidationError("payload must be an object");
  }

  const page = objectOrUndefined(root.page);
  const pageId = stringOrUndefined(page?.id);
  if (pageId === undefined) {
    throw new WebhookValidationError("page.id must be a non-empty string");
  }

  const normalizedPage = {
    id: pageId,
    ...field("statusIndicator", stringOrUndefined(page?.status_indicator)),
    ...field("statusDescription", stringOrUndefined(page?.status_description)),
  };

  const incident = objectOrUndefined(root.incident);
  if (incident !== undefined) {
    const latestUpdate = latestIncidentUpdate(incident.incident_updates);
    const normalizedIncident: QueueEventEnvelope["event"] = {
      type: "incident",
      page: normalizedPage,
      incident: {
        ...field("id", stringOrUndefined(incident.id)),
        ...field("name", stringOrUndefined(incident.name)),
        ...field("status", stringOrUndefined(incident.status)),
        ...field("impact", stringOrUndefined(incident.impact)),
        ...field("shortlink", stringOrUndefined(incident.shortlink)),
        ...field("createdAt", stringOrUndefined(incident.created_at)),
        ...field("updatedAt", stringOrUndefined(incident.updated_at)),
        ...(latestUpdate === undefined ? {} : { latestUpdate }),
      },
    };
    return {
      kind: "accepted",
      envelope: { version: 1, receivedAt, event: normalizedIncident },
    };
  }

  const component = objectOrUndefined(root.component);
  const componentUpdate = objectOrUndefined(root.component_update);
  if (component !== undefined && componentUpdate !== undefined) {
    const componentFields = {
      ...field("id", stringOrUndefined(component.id)),
      ...field("name", stringOrUndefined(component.name)),
      ...field("status", stringOrUndefined(component.status)),
    };

    const updateFields = {
      ...field("id", stringOrUndefined(componentUpdate.id)),
      ...field("oldStatus", stringOrUndefined(componentUpdate.old_status)),
      ...field("newStatus", stringOrUndefined(componentUpdate.new_status)),
      ...field("createdAt", stringOrUndefined(componentUpdate.created_at)),
    };

    return {
      kind: "accepted",
      envelope: {
        version: 1,
        receivedAt,
        event: {
          type: "component",
          page: normalizedPage,
          component: componentFields,
          update: updateFields,
        },
      },
    };
  }

  return { kind: "ignored", reason: "unsupported_event" };
}
