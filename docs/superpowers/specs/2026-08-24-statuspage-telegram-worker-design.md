# Statuspage Telegram Cloudflare Worker Design

**Date:** 2026-08-24  
**Status:** Approved for implementation

## 1. Summary

Build a TypeScript Cloudflare Worker that acts as a shared webhook endpoint for multiple Atlassian Statuspage subscriptions. Every supported Statuspage event received by one Worker deployment is delivered to the same configured set of Telegram users or groups through the Telegram Bot API `sendMessage` method.

Each deployment may use a different custom domain, but all deployments expose the same paths and run the same code. Runtime configuration is stored in Workers KV, secrets remain in Cloudflare Worker Secrets, and Cloudflare Queues provides asynchronous delivery and retries.

## 2. Confirmed Requirements

- Accept webhook notifications from multiple Statuspage pages through one endpoint:

  ```text
  POST https://<worker-domain>/webhook?token=<WEBHOOK_SECRET>
  ```

- All supported events received by one Worker deployment go to the same list of Telegram targets.
- Support multiple Telegram user or group `chat_id` values.
- Use one Telegram bot per Worker deployment.
- Distinguish source pages using a KV mapping from Statuspage `page.id` to a friendly name and optional URL.
- Format notifications using Chinese labels, severity emoji, and the original Statuspage event text.
- Protect the endpoint with a shared query-string secret because the referenced Statuspage webhook format does not provide a cryptographic signature.
- Store mutable non-secret configuration in Workers KV and manage it only through the Cloudflare dashboard or Wrangler; do not expose an HTTP administration API.
- Use Cloudflare Queues for asynchronous delivery and retry handling.
- Use KV-backed, target-level delivery records to reduce duplicate Telegram messages during Queue retries.
- Include automated tests and complete deployment documentation.

## 3. Source Documentation Constraints

The Atlassian documentation states that Statuspage webhooks:

- are HTTP `POST` requests;
- are sent when an incident is created or updated and when a component changes status;
- contain a `page` object and either incident-specific or component-specific fields;
- require the endpoint to return a `2xx` response within 30 seconds;
- treat `3xx` as failure;
- do not document a webhook signature in the referenced payload format.

Reference: <https://support.atlassian.com/statuspage/docs/enable-webhook-notifications/>

Cloudflare free-plan limits relevant to this design, as documented when this design was written:

- Workers KV: 100,000 reads/day, 1,000 writes/day, 1,000 deletes/day, 1,000 list requests/day, and 1 GB stored data.
- Cloudflare Queues: 10,000 standard operations/day and 24-hour message retention. A normal successfully delivered message generally consumes three operations: write, read, and delete.

References:

- <https://developers.cloudflare.com/kv/platform/pricing/>
- <https://developers.cloudflare.com/queues/platform/pricing/>

## 4. Goals and Non-Goals

### Goals

- Fast webhook acknowledgement after durable Queue acceptance.
- Reliable asynchronous Telegram delivery with bounded retries.
- Support both documented Statuspage incident and component update payloads.
- Send concise, readable Chinese Telegram notifications.
- Allow configuration changes without redeploying code.
- Make separate Worker deployments straightforward for separate custom domains.
- Keep the runtime dependency-free and the code divided into focused, testable modules.

### Non-Goals

- No browser UI or HTTP administration API.
- No per-Statuspage Telegram routing within a deployment; every page uses the same target list.
- No support for multiple Telegram bot tokens in one deployment.
- No guaranteed exactly-once delivery. Queue delivery is at-least-once, and Telegram sending cannot be transacted atomically with KV writes.
- No automatic Statuspage subscription creation through the Statuspage API.
- No Slack or other notification providers.
- No Telegram forum-topic routing in the initial version.

## 5. Architecture

One TypeScript Module Worker implements both Cloudflare entry points:

- `fetch(request, env, ctx)` for HTTP webhook and health requests;
- `queue(batch, env, ctx)` for Queue consumption and Telegram delivery.

```text
Statuspage
    |
    | POST /webhook?token=...
    v
Worker fetch handler
    | validate, normalize, enqueue
    v
Cloudflare Queue -----------------------> Dead Letter Queue
    |
    | consume with bounded retries
    v
Worker queue handler
    | read config and delivery records
    +-----------------> Workers KV
    |
    | Telegram Bot API sendMessage
    v
Telegram users and groups
```

### Cloudflare Bindings and Secrets

The Worker environment exposes:

- `STATUSPAGE_KV`: one KV namespace containing configuration and expiring delivery records;
- `NOTIFICATION_QUEUE`: producer binding for the primary Queue;
- `TELEGRAM_BOT_TOKEN`: Worker Secret;
- `WEBHOOK_SECRET`: Worker Secret.

The Worker is also registered as the consumer for the primary Queue. The Queue is configured with a separate dead-letter queue.

## 6. HTTP Interface

### `POST /webhook`

Required query parameter:

```text
token=<WEBHOOK_SECRET>
```

Processing order:

1. Verify the HTTP method and exact path.
2. Compare the supplied token with `WEBHOOK_SECRET` by hashing both values with SHA-256 and comparing equal-length digest bytes.
3. Reject an oversized body before processing when `Content-Length` proves it exceeds the limit, and enforce the same limit after reading when the header is absent or unreliable.
4. Parse JSON.
5. Require a non-empty string `page.id`.
6. Recognize an incident event when `incident` is an object.
7. Recognize a component event when `component_update` and `component` are objects.
8. Normalize required event fields into a typed Queue envelope and enqueue it.
9. Return `202` only after Queue acceptance succeeds.

The input body limit is 128 KiB. Normalization retains only fields needed for formatting, linking, time display, status translation, fingerprinting, and diagnostics so Queue messages normally remain below 64 KB.

Responses:

- `202`: event accepted by the Queue;
- `202`: authenticated but unsupported event ignored, with a machine-readable `reason`;
- `400`: malformed JSON or invalid required fields;
- `401`: missing or invalid token;
- `404`: unknown path;
- `405`: known path with an unsupported method;
- `413`: request body too large;
- `503`: Queue acceptance failed, allowing Statuspage to retry.

No response contains secrets or internal configuration.

### `GET /health`

Returns a small JSON response indicating that the Worker process is reachable. It is a shallow health check and does not reveal KV content, Queue names, Telegram targets, or secret validity.

Example:

```json
{
  "ok": true,
  "service": "statuspage-telegram-worker"
}
```

### Other Requests

All other paths return `404`. Redirects are not used for webhook requests because Statuspage treats `3xx` as failure.

## 7. Queue Event Model

The producer writes a versioned envelope:

```ts
interface QueueEventEnvelope {
  version: 1;
  receivedAt: string;
  event:
    | NormalizedIncidentEvent
    | NormalizedComponentEvent;
}
```

Both normalized variants include:

- event type;
- `page.id`;
- page status indicator and description when present;
- relevant entity IDs;
- names and statuses;
- relevant timestamps;
- safe link candidates;
- the latest incident update for incident events;
- enough stable source fields to calculate a fallback fingerprint.

For incident payloads, the latest update is selected by the most recent valid `display_at`, then `created_at`, then `updated_at` timestamp rather than assuming array order. If timestamps are unavailable, the final array item is used.

## 8. KV Configuration Model

The `config` key contains one JSON document:

```json
{
  "version": 1,
  "timezone": "Asia/Shanghai",
  "telegram": {
    "targets": [
      {
        "chatId": "123456789",
        "label": "管理员"
      },
      {
        "chatId": "-1001234567890",
        "label": "运维群"
      }
    ]
  },
  "pages": {
    "j2mfxwj97wnj": {
      "name": "示例服务状态",
      "url": "https://status.example.com"
    }
  }
}
```

Rules:

- `version` must equal `1`.
- `timezone` is optional and defaults to `Asia/Shanghai`; when present it must be a valid IANA time-zone name.
- `telegram.targets` must be a non-empty array.
- `chatId` is a non-empty string so negative group IDs and large identifiers are represented safely.
- `label` is optional and is used only in sanitized operational logs.
- `pages` is keyed by Statuspage `page.id`.
- Page `name` is required for configured pages.
- Page `url` is optional and is used only if it is an absolute `http` or `https` URL.
- An unconfigured page is still delivered using its raw `page.id` as the display name, preventing missed alerts.
- Invalid or missing configuration causes Queue processing to retry rather than silently acknowledging the event.

The configuration is updated through the Cloudflare dashboard or a Wrangler KV command. There is no management route in the Worker. KV is eventually consistent, so a configuration update may take time to become visible in every location.

## 9. Telegram Message Formatting

The consumer calls:

```text
POST https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage
```

with JSON containing:

- `chat_id`;
- `text`;
- `parse_mode: "HTML"`;
- `link_preview_options: { "is_disabled": true }`.

All Statuspage-controlled and configuration-controlled text is HTML-escaped. Link values are accepted only after absolute `http`/`https` URL validation and are escaped for use in an HTML attribute.

### Incident Message Shape

```text
🔴 示例服务状态：重大事件

事件：Virginia Is Down
状态：监控中
影响：严重
页面状态：重大服务中断

更新：
A fix has been implemented and we are monitoring the results.

时间：2026-03-12 14:30:35
查看详情
```

The page name links to the configured page URL when available. The incident name or final detail link uses the incident `shortlink` when it is a valid URL. Only the newest incident update is displayed.

### Component Message Shape

```text
🟢 示例服务状态：组件状态更新

组件：Some Component
状态：大面积中断 → 正常
页面状态：部分服务中断
时间：2026-03-12 14:30:35
```

### Translation and Severity

Known values receive Chinese labels. Unknown values remain visible in their original form.

Component status translations include:

- `operational` → `正常`;
- `degraded_performance` → `性能下降`;
- `partial_outage` → `部分中断`;
- `major_outage` → `大面积中断`;
- `under_maintenance` → `维护中`.

Incident status translations include:

- `investigating` → `调查中`;
- `identified` → `已定位`;
- `monitoring` → `监控中`;
- `resolved` → `已解决`;
- `scheduled` → `已计划`;
- `in_progress` → `维护中`;
- `verifying` → `验证中`;
- `completed` → `已完成`.

Impact translations include:

- `none` → `无影响`;
- `minor` → `轻微`;
- `major` → `严重`;
- `critical` → `紧急`;
- `maintenance` → `维护`.

Emoji selection uses the strongest available signal from impact, incident status, component status, and page indicator:

- green for normal, resolved, or completed states;
- blue for scheduled maintenance states;
- yellow for degraded, minor, investigating, identified, or monitoring states;
- orange for partial outage or major impact;
- red for critical impact or major outage;
- white for unknown states.

Messages are assembled from bounded plain-text fields before HTML escaping. Long event bodies are truncated with an explicit ellipsis so the final Telegram message remains safely below the 4096-character Bot API limit. One Statuspage event produces at most one Telegram message per target.

## 10. Fingerprinting and Best-Effort Deduplication

The event fingerprint is calculated as follows:

- Incident: `page.id`, `incident.id`, and the newest `incident_update.id` when all are available.
- Component: `page.id` and `component_update.id` when available.
- Fallback: SHA-256 of a deterministic serialization of the normalized event.

For each target, the consumer hashes the `chatId` and checks this key:

```text
delivery:v1:<event-fingerprint>:<target-hash>
```

When the key exists, that target is skipped. After Telegram confirms a successful `sendMessage`, the consumer writes the key with a seven-day TTL.

The raw `chatId` is not embedded in the KV key. The delivery value contains only minimal diagnostic data such as a success timestamp and Telegram message ID when returned.

This mechanism prevents common duplicates caused by Queue retries after partial fan-out. It cannot provide exactly-once semantics because Telegram delivery and KV persistence are separate operations. For example, Telegram may accept a message immediately before the Worker loses the ability to write the delivery key. This residual duplicate risk is documented in the README.

Free-plan KV writes can become the practical limit before Queue operations if notification volume or target count is unusually high. The expected Statuspage alert volume is well within the free allowance, but the README will explain how one event sent to N targets produces up to N delivery-record writes.

## 11. Queue Consumption, Retry, and DLQ

The consumer processes each Queue message independently, even when Cloudflare supplies a batch.

For each message:

1. Read and validate KV `config` once.
2. Resolve the page display metadata, falling back to `page.id`.
3. Format the Telegram message once.
4. Calculate the event fingerprint.
5. For every configured target, check its delivery key.
6. Send concurrently to targets without delivery records.
7. Persist delivery keys for successful targets.
8. Acknowledge the Queue message only when every target is either already recorded or successfully delivered and recorded.
9. Retry the Queue message if any target remains unsuccessful.

Retry delay behavior:

- Telegram `429`: use the largest valid `parameters.retry_after` returned by failed target calls, bounded to a safe Queue delay.
- Network failures, Telegram `5xx`, invalid Telegram responses, and other non-2xx responses: use bounded exponential backoff derived from Queue attempt count.
- KV read/write failures and invalid/missing runtime configuration: retry with bounded exponential backoff.

The primary Queue is configured for a maximum of five retries. Exhausted messages are transferred to `statuspage-telegram-dlq`. On the Workers Free plan, both primary and dead-letter messages have 24-hour retention. The README explains monitoring, temporary pull-consumer inspection, correcting configuration, and re-submitting a failed event within that window.

Structured logs record:

- Queue message ID and attempt count;
- event type and fingerprint;
- Statuspage `page.id`;
- target label or a short hash, never a full `chatId`;
- Telegram HTTP status and sanitized API description;
- acknowledgement, retry delay, and exhausted-delivery context.

Logs never include the webhook secret, bot token, complete authenticated webhook URL, or full request payload by default.

## 12. Security Model

- `TELEGRAM_BOT_TOKEN` and `WEBHOOK_SECRET` are Worker Secrets, not source-controlled values or KV entries.
- The webhook secret is required because the referenced Statuspage format has no documented signature.
- The query-string token may appear in infrastructure access records outside application logging. It must be long, random, unique per deployment, and rotatable. Application code does not log request URLs.
- Request shape and size are validated before Queue publication.
- External text is escaped before Telegram HTML rendering.
- External links are restricted to absolute HTTP(S) URLs.
- Health output and error responses expose no binding names, target IDs, tokens, or configuration values.
- Configuration management remains outside the public HTTP surface.

## 13. Error Handling Summary

### Producer

- Authentication and validation errors are handled synchronously with `4xx` responses.
- Authenticated unsupported events return `202` with an ignored reason to avoid repeated delivery of an event version the Worker intentionally does not process.
- Queue publication failure returns `503`, allowing Statuspage to retry.

### Consumer

- Configuration, KV, Queue-runtime, network, Telegram, and delivery-record failures are logged and retried.
- Successful targets are protected from normal partial-failure retries by target-level delivery records.
- After five retries, unresolved events move to the DLQ.
- No Telegram failure can change an already returned Statuspage webhook response because delivery is asynchronous.

## 14. Project Structure

```text
src/
  index.ts          # Module Worker fetch and queue entry points
  webhook.ts        # Request validation and Statuspage normalization
  consumer.ts       # Queue fan-out, acknowledgement, and retry decisions
  formatter.ts      # Chinese Telegram HTML formatting
  telegram.ts       # Telegram sendMessage client and response parsing
  config.ts         # KV configuration parsing and validation
  dedup.ts          # Stable event fingerprints and delivery keys
  types.ts          # Environment, payload, config, and Queue types
test/
  webhook.test.ts
  formatter.test.ts
  consumer.test.ts
  fixtures/
    incident.json
    component-update.json
config.example.json
package.json
tsconfig.json
vitest.config.ts
wrangler.jsonc
README.md
```

The runtime uses native Worker APIs and has no production dependencies. Development dependencies include TypeScript, Wrangler, Vitest, Cloudflare Worker types, and the supported Cloudflare Vitest Worker pool.

## 15. Test Strategy

Implementation follows test-driven development. Tests include pure unit tests for deterministic modules and Worker-environment tests for bindings and entry points.

Required coverage:

- exact routes and methods;
- valid, missing, and invalid webhook tokens;
- fixed-time digest comparison behavior at the public interface;
- request size enforcement;
- malformed JSON and missing `page.id`;
- incident and component fixtures based on Atlassian's documented examples;
- unsupported authenticated event acknowledgement;
- Queue publication success and failure;
- newest incident-update selection by timestamp;
- all documented Chinese translations and severity emoji classes;
- unknown status preservation;
- configured and unknown page display behavior;
- valid and invalid configured links;
- HTML injection escaping;
- Telegram length-safe truncation;
- KV configuration validation and default time zone;
- stable fingerprints and hashed target delivery keys;
- successful multi-target fan-out;
- pre-existing delivery records being skipped;
- partial success followed by retry without resending recorded targets;
- Telegram `429` retry-after handling;
- network, `5xx`, non-2xx, and malformed Telegram responses;
- KV read/write failures;
- missing or invalid configuration;
- Queue acknowledgement, retry, and delay decisions;
- health and not-found responses.

No automated test calls the real Telegram API or mutates production Cloudflare resources.

## 16. Deployment and Operations Documentation

The README provides exact commands and examples for:

1. installing dependencies;
2. creating the KV namespace;
3. creating the primary Queue and DLQ;
4. setting Wrangler binding and consumer configuration;
5. creating `TELEGRAM_BOT_TOKEN` and `WEBHOOK_SECRET` secrets;
6. validating and uploading `config.json` to KV key `config`;
7. running tests, type checking, and a Wrangler deployment dry run;
8. deploying the Worker;
9. binding a custom domain;
10. configuring multiple Statuspage subscriptions with the same endpoint URL for that deployment;
11. retrieving a Statuspage `page.id` from its public API or a received payload;
12. obtaining Telegram user and group `chat_id` values and granting the bot access;
13. sending local fixture requests;
14. tailing sanitized Worker logs;
15. understanding Queue retries, free-plan retention, DLQ inspection, and manual replay;
16. rotating the shared webhook secret and Telegram bot token;
17. deploying the same code under another Worker name and custom domain with independent resources and secrets.

## 17. Verification and Acceptance Criteria

The implementation is accepted when:

- automated tests pass;
- TypeScript type checking passes;
- Wrangler validates the project and completes a deployment dry run;
- the documented incident fixture is accepted, queued, formatted, and sent once to every configured test target;
- the documented component fixture is accepted, queued, formatted, and sent once to every configured test target;
- invalid tokens cannot enqueue events;
- a Queue publication failure returns `503`;
- a partial Telegram failure retries only unresolved targets in the normal retry path;
- Telegram content is valid escaped HTML and remains below its message length limit;
- no secret or full target identifier appears in application logs or HTTP responses;
- README deployment steps are complete enough to deploy a fresh Worker using a free Cloudflare account.
