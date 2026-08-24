# Statuspage Telegram Cloudflare Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready Cloudflare Worker that accepts multiple Atlassian Statuspage webhooks, queues normalized events, and reliably fans them out to a KV-configured set of Telegram chats.

**Architecture:** One TypeScript Module Worker exposes `fetch()` and `queue()`. The fetch handler authenticates and normalizes Statuspage payloads before publishing one versioned event to Cloudflare Queues; the queue handler reads one KV configuration document, formats Chinese Telegram HTML, sends concurrently, and writes per-target KV delivery records for best-effort deduplication.

**Tech Stack:** Node.js 22+, TypeScript 7, Cloudflare Workers, Workers KV, Cloudflare Queues, Telegram Bot API, Wrangler 4, Vitest 4, `@cloudflare/vitest-plugin` 1.

**Spec:** `docs/superpowers/specs/2026-08-24-statuspage-telegram-worker-design.md`

## Global Constraints

- Use TypeScript Module Worker syntax with compatibility date `2026-08-24`.
- Require Node.js `>=22.0.0` for development tooling.
- Keep production runtime dependencies empty; use only native Worker APIs.
- Expose only `GET /health` and authenticated `POST /webhook?token=...`; do not add an administration API.
- Route every supported page in one deployment to the same non-empty Telegram target list.
- Store `config` and expiring delivery records in one `STATUSPAGE_KV` namespace.
- Store `TELEGRAM_BOT_TOKEN` and `WEBHOOK_SECRET` only as Worker Secrets.
- Publish exactly one Queue message per accepted Statuspage webhook.
- Configure five Queue retries and `statuspage-telegram-dlq` as the dead-letter queue.
- Use Chinese labels, Telegram HTML parse mode, disabled link previews, and a final message length below 4096 characters.
- Support documented incident and component-update payloads; acknowledge authenticated unsupported payloads as ignored.
- Treat Queue/KV/Telegram delivery as at-least-once and provide best-effort target-level deduplication with seven-day TTL.
- Never log the bot token, webhook secret, complete authenticated URL, full `chatId`, or full raw payload.
- Follow TDD: every behavioral implementation begins with a failing focused test.

---

## File Map

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Module Worker entry point and HTTP route dispatch |
| `src/types.ts` | Shared Worker environment, normalized event, config, Telegram, and delivery types |
| `src/config.ts` | Parse and validate KV `config`; load it from KV |
| `src/webhook.ts` | Validate/normalize Statuspage JSON and select the latest incident update |
| `src/formatter.ts` | Translate statuses and build safe Chinese Telegram HTML |
| `src/dedup.ts` | Stable SHA-256 event fingerprints, target hashes, and delivery KV records |
| `src/telegram.ts` | Telegram `sendMessage` request and response parsing |
| `src/consumer.ts` | Queue fan-out, target-level deduplication, logging, acknowledgement, and retry decisions |
| `test/index.test.ts` | Health, routing, authentication, size, parsing, and Queue-producer tests |
| `test/config.test.ts` | KV config validation tests |
| `test/webhook.test.ts` | Statuspage normalization tests |
| `test/formatter.test.ts` | Chinese formatting, HTML safety, links, time zone, and length tests |
| `test/dedup.test.ts` | Fingerprint and delivery-record tests |
| `test/telegram.test.ts` | Telegram API client tests using injected fetch |
| `test/consumer.test.ts` | Queue acknowledgement, partial retry, deduplication, and log-redaction tests |
| `test/worker.integration.test.ts` | Producer-to-consumer fixture flow for both event types |
| `test/fixtures/incident.json` | Atlassian-style incident webhook fixture |
| `test/fixtures/component-update.json` | Atlassian-style component webhook fixture |
| `test/env.d.ts` | Type the Vitest Worker bindings as `WorkerEnv` |
| `test/tsconfig.json` | Worker-runtime test compiler configuration |
| `config.example.json` | Valid example KV configuration |
| `.dev.vars.example` | Explicit local-only dummy secret names and values |
| `.gitignore` | Ignore secrets, dependencies, Wrangler state, coverage, and build output |
| `package.json` / `package-lock.json` | Tool versions and scripts |
| `tsconfig.json` | Strict Worker TypeScript configuration |
| `vitest.config.ts` | Cloudflare Worker Vitest plugin and local test bindings |
| `wrangler.jsonc` | Worker, KV, Queue, DLQ, observability, and secret declarations |
| `worker-configuration.d.ts` | Generated Cloudflare runtime and binding types |
| `README.md` | Setup, configuration, deployment, Statuspage, Telegram, logging, retry, and quota guide |

---

### Task 1: Bootstrap the Worker, Cloudflare bindings, and health endpoint

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `test/tsconfig.json`
- Create: `test/env.d.ts`
- Create: `vitest.config.ts`
- Create: `wrangler.jsonc`
- Create: `worker-configuration.d.ts` via Wrangler
- Create: `src/types.ts`
- Create: `src/index.ts`
- Create: `test/index.test.ts`

**Interfaces:**
- Produces: `WorkerEnv`, `QueueEventEnvelope`, and all shared data interfaces from `src/types.ts`.
- Produces: `handleFetch(request: Request, env: WorkerEnv, deps?: FetchDependencies): Promise<Response>`.
- Produces: default Module Worker export with `fetch`.
- Consumes: no earlier task interfaces.

- [ ] **Step 1: Create the package and Cloudflare tool configuration**

Create `package.json` exactly with no production dependencies:

```json
{
  "name": "statuspage-telegram-worker",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "cf-typegen": "wrangler types",
    "dev": "wrangler dev",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit && tsc -p test/tsconfig.json --noEmit",
    "deploy:dry-run": "wrangler deploy --dry-run --outdir dist",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "1.0.0",
    "@types/node": "26.2.0",
    "typescript": "7.0.2",
    "vitest": "4.1.11",
    "wrangler": "4.125.0"
  }
}
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
coverage/
.wrangler/
.dev.vars
.dev.vars.*
!.dev.vars.example
.env
.env.*
config.json
*.log
```

Create `wrangler.jsonc`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "statuspage-telegram-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-24",
  "workers_dev": true,
  "observability": {
    "enabled": true
  },
  "kv_namespaces": [
    {
      "binding": "STATUSPAGE_KV"
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "NOTIFICATION_QUEUE",
        "queue": "statuspage-telegram-notifications"
      }
    ],
    "consumers": [
      {
        "queue": "statuspage-telegram-notifications",
        "max_batch_size": 5,
        "max_batch_timeout": 5,
        "max_retries": 5,
        "dead_letter_queue": "statuspage-telegram-dlq"
      }
    ]
  },
  "secrets": {
    "required": [
      "TELEGRAM_BOT_TOKEN",
      "WEBHOOK_SECRET"
    ]
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "WebWorker"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts", "worker-configuration.d.ts"]
}
```

Create `test/tsconfig.json`:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": ["@cloudflare/vitest-plugin/types", "vitest/globals"]
  },
  "include": [
    "./**/*.ts",
    "./env.d.ts",
    "../src/**/*.ts",
    "../worker-configuration.d.ts",
    "../config.example.json"
  ]
}
```

Create `vitest.config.ts`:

```ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TELEGRAM_BOT_TOKEN: "test-bot-token",
          WEBHOOK_SECRET: "test-webhook-secret",
        },
        kvNamespaces: ["STATUSPAGE_KV"],
        compatibilityFlags: ["service_binding_extra_handlers"],
        queueConsumers: {
          "statuspage-telegram-notifications": { maxBatchTimeout: 0.05 },
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Install dependencies and generate Worker types**

Run:

```bash
npm install
npm run cf-typegen
```

Expected: `package-lock.json` and `worker-configuration.d.ts` are created; both commands exit `0`.

- [ ] **Step 3: Define the shared interfaces**

Create `src/types.ts` with these exact public shapes:

```ts
export interface PageStatus {
  id: string;
  statusIndicator?: string;
  statusDescription?: string;
}

export interface NormalizedIncidentUpdate {
  id?: string;
  body?: string;
  status?: string;
  displayAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NormalizedIncidentEvent {
  type: "incident";
  page: PageStatus;
  incident: {
    id?: string;
    name?: string;
    status?: string;
    impact?: string;
    shortlink?: string;
    createdAt?: string;
    updatedAt?: string;
    latestUpdate?: NormalizedIncidentUpdate;
  };
}

export interface NormalizedComponentEvent {
  type: "component";
  page: PageStatus;
  component: {
    id?: string;
    name?: string;
    status?: string;
  };
  update: {
    id?: string;
    oldStatus?: string;
    newStatus?: string;
    createdAt?: string;
  };
}

export type NormalizedStatuspageEvent =
  | NormalizedIncidentEvent
  | NormalizedComponentEvent;

export interface QueueEventEnvelope {
  version: 1;
  receivedAt: string;
  event: NormalizedStatuspageEvent;
}

export interface TelegramTarget {
  chatId: string;
  label?: string;
}

export interface StatuspageConfig {
  name: string;
  url?: string;
}

export interface WorkerConfig {
  version: 1;
  timezone: string;
  telegram: {
    targets: TelegramTarget[];
  };
  pages: Record<string, StatuspageConfig>;
}

export interface WorkerEnv {
  STATUSPAGE_KV: KVNamespace;
  NOTIFICATION_QUEUE: Queue<QueueEventEnvelope>;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
}

export interface FetchDependencies {
  now(): Date;
}

export interface DeliveryRecord {
  sentAt: string;
  telegramMessageId?: number;
}
```

Create `test/env.d.ts`:

```ts
import type { WorkerEnv } from "../src/types";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends WorkerEnv {}
}
```

- [ ] **Step 4: Write the failing health and route tests**

Create `test/index.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function dispatch(path: string, method = "GET") {
  const request = new IncomingRequest(`https://status-alerts.example.com${path}`, {
    method,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
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
```

- [ ] **Step 5: Run the health test and confirm failure**

Run:

```bash
npm test -- test/index.test.ts
```

Expected: FAIL because `src/index.ts` does not exist.

- [ ] **Step 6: Implement only the health and not-found routing**

Create `src/index.ts`:

```ts
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
```

- [ ] **Step 7: Run foundation verification**

Run:

```bash
npm test -- test/index.test.ts
npm run typecheck
```

Expected: all three route tests PASS; both TypeScript invocations exit `0`.

- [ ] **Step 8: Commit the foundation**

```bash
git add .gitignore package.json package-lock.json tsconfig.json test/tsconfig.json test/env.d.ts vitest.config.ts wrangler.jsonc worker-configuration.d.ts src/types.ts src/index.ts test/index.test.ts
git commit -m "chore: bootstrap Cloudflare worker"
```

---

### Task 2: Parse and validate the KV configuration

**Files:**
- Create: `src/config.ts`
- Create: `test/config.test.ts`
- Create: `config.example.json`

**Interfaces:**
- Consumes: `WorkerConfig` from `src/types.ts`.
- Produces: `ConfigError`.
- Produces: `parseWorkerConfig(input: unknown): WorkerConfig`.
- Produces: `loadWorkerConfig(kv: KVNamespace): Promise<WorkerConfig>`.

- [ ] **Step 1: Write failing config-validation tests**

Create `config.example.json`:

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

Create `test/config.test.ts` with one table-driven block and KV loading tests:

```ts
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import exampleConfig from "../config.example.json";
import { ConfigError, loadWorkerConfig, parseWorkerConfig } from "../src/config";

afterEach(async () => reset());

describe("parseWorkerConfig", () => {
  it("accepts the documented example", () => {
    expect(parseWorkerConfig(exampleConfig)).toEqual(exampleConfig);
  });

  it("defaults timezone to Asia/Shanghai", () => {
    const input = structuredClone(exampleConfig) as Record<string, unknown>;
    delete input.timezone;
    expect(parseWorkerConfig(input).timezone).toBe("Asia/Shanghai");
  });

  it.each([
    ["wrong version", { ...exampleConfig, version: 2 }],
    ["invalid timezone", { ...exampleConfig, timezone: "Mars/Olympus" }],
    ["empty targets", { ...exampleConfig, telegram: { targets: [] } }],
    [
      "blank chat id",
      { ...exampleConfig, telegram: { targets: [{ chatId: "   " }] } },
    ],
    [
      "duplicate chat id",
      {
        ...exampleConfig,
        telegram: { targets: [{ chatId: "1" }, { chatId: "1" }] },
      },
    ],
    [
      "invalid page url",
      {
        ...exampleConfig,
        pages: { page: { name: "Page", url: "javascript:alert(1)" } },
      },
    ],
    ["blank page name", { ...exampleConfig, pages: { page: { name: " " } } }],
  ])("rejects %s", (_name, input) => {
    expect(() => parseWorkerConfig(input)).toThrow(ConfigError);
  });
});

describe("loadWorkerConfig", () => {
  it("loads and validates the config key", async () => {
    await env.STATUSPAGE_KV.put("config", JSON.stringify(exampleConfig));
    await expect(loadWorkerConfig(env.STATUSPAGE_KV)).resolves.toEqual(exampleConfig);
  });

  it("rejects a missing config key", async () => {
    await expect(loadWorkerConfig(env.STATUSPAGE_KV)).rejects.toThrow(
      "KV config key is missing",
    );
  });
});
```

- [ ] **Step 2: Run config tests and confirm failure**

Run:

```bash
npm test -- test/config.test.ts
```

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 3: Implement strict native validation**

Create `src/config.ts`. Implement these exact rules rather than coercing invalid values:

```ts
import type {
  StatuspageConfig,
  TelegramTarget,
  WorkerConfig,
} from "./types";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function optionalHttpUrl(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  const input = nonEmptyString(value, path);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ConfigError(`${path} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${path} must be an absolute HTTP(S) URL`);
  }
  return input;
}

function validateTimeZone(value: unknown): string {
  const timezone = value === undefined ? "Asia/Shanghai" : nonEmptyString(value, "timezone");
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format(0);
  } catch {
    throw new ConfigError("timezone must be a valid IANA time zone");
  }
  return timezone;
}
```

Complete `parseWorkerConfig()` with the following deterministic behavior:

1. Require the root object and `version === 1`.
2. Require `telegram` as an object and `telegram.targets` as a non-empty array.
3. Parse every target to `{ chatId, label? }`; trim strings; reject duplicate `chatId` values.
4. Require `pages` as an object. For every entry, require a non-empty page ID key, a non-empty `name`, and an optional valid HTTP(S) URL.
5. Return a fresh `WorkerConfig`; do not mutate or return the input object.

Use this return shape:

```ts
return {
  version: 1,
  timezone,
  telegram: { targets },
  pages,
};
```

Implement KV loading without swallowing KV or parse errors:

```ts
export async function loadWorkerConfig(kv: KVNamespace): Promise<WorkerConfig> {
  const value = await kv.get<unknown>("config", "json");
  if (value === null) {
    throw new ConfigError("KV config key is missing");
  }
  return parseWorkerConfig(value);
}
```

- [ ] **Step 4: Verify config behavior**

Run:

```bash
npm test -- test/config.test.ts
npm run typecheck
```

Expected: all config tests PASS; type checking exits `0`.

- [ ] **Step 5: Commit KV configuration support**

```bash
git add src/config.ts test/config.test.ts config.example.json
git commit -m "feat: validate KV notification config"
```

---

### Task 3: Normalize Statuspage incident and component payloads

**Files:**
- Create: `src/webhook.ts`
- Create: `test/webhook.test.ts`
- Create: `test/fixtures/incident.json`
- Create: `test/fixtures/component-update.json`

**Interfaces:**
- Consumes: normalized event and Queue envelope types from `src/types.ts`.
- Produces: `WebhookValidationError`.
- Produces: `NormalizationResult`.
- Produces: `normalizeStatuspagePayload(payload: unknown, receivedAt: string): NormalizationResult`.

- [ ] **Step 1: Add Atlassian-style fixtures**

Create `test/fixtures/component-update.json`:

```json
{
  "meta": {
    "unsubscribe": "https://status.example.com/?unsubscribe=abc",
    "documentation": "https://support.atlassian.com/statuspage/"
  },
  "page": {
    "id": "j2mfxwj97wnj",
    "status_indicator": "major",
    "status_description": "Partial System Outage"
  },
  "component_update": {
    "created_at": "2026-08-24T04:30:00Z",
    "new_status": "operational",
    "old_status": "major_outage",
    "id": "k7730b5v92bv",
    "component_id": "rb5wq1dczvbm"
  },
  "component": {
    "created_at": "2020-01-01T00:00:00Z",
    "id": "rb5wq1dczvbm",
    "name": "Some Component",
    "status": "operational"
  }
}
```

Create `test/fixtures/incident.json`:

```json
{
  "meta": {
    "unsubscribe": "https://status.example.com/?unsubscribe=abc",
    "documentation": "https://support.atlassian.com/statuspage/"
  },
  "page": {
    "id": "j2mfxwj97wnj",
    "status_indicator": "critical",
    "status_description": "Major System Outage"
  },
  "incident": {
    "backfilled": false,
    "created_at": "2026-08-24T03:00:00Z",
    "impact": "critical",
    "shortlink": "https://stspg.io/example",
    "status": "monitoring",
    "updated_at": "2026-08-24T04:30:35Z",
    "id": "lbkhbwn21v5q",
    "name": "Virginia Is Down",
    "incident_updates": [
      {
        "body": "A fix has been implemented and we are monitoring the results.",
        "created_at": "2026-08-24T04:07:53Z",
        "display_at": "2026-08-24T04:07:53Z",
        "status": "monitoring",
        "updated_at": "2026-08-24T04:09:09Z",
        "id": "latest-update",
        "incident_id": "lbkhbwn21v5q"
      },
      {
        "body": "We are investigating elevated errors.",
        "created_at": "2026-08-24T03:05:00Z",
        "display_at": "2026-08-24T03:05:00Z",
        "status": "investigating",
        "updated_at": "2026-08-24T03:06:00Z",
        "id": "older-update",
        "incident_id": "lbkhbwn21v5q"
      }
    ]
  }
}
```

The newest incident update deliberately appears first so implementation cannot rely on the final array item.

- [ ] **Step 2: Write failing normalization tests**

Create `test/webhook.test.ts`:

```ts
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

  it("acknowledges an unsupported authenticated payload as ignored", () => {
    expect(
      normalizeStatuspagePayload(
        { page: { id: "page-id" }, future_event: { id: "1" } },
        receivedAt,
      ),
    ).toEqual({ kind: "ignored", reason: "unsupported_event" });
  });
});
```

- [ ] **Step 3: Run normalization tests and confirm failure**

Run:

```bash
npm test -- test/webhook.test.ts
```

Expected: FAIL because `src/webhook.ts` does not exist.

- [ ] **Step 4: Implement defensive normalization**

Create `src/webhook.ts` with these exports:

```ts
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
```

Use non-coercing helpers:

```ts
function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
```

Implement latest-update selection with this ranking order:

```ts
function timestamp(update: NormalizedIncidentUpdate): number | undefined {
  for (const candidate of [update.displayAt, update.createdAt, update.updatedAt]) {
    if (candidate === undefined) continue;
    const value = Date.parse(candidate);
    if (!Number.isNaN(value)) return value;
  }
  return undefined;
}
```

Normalize every `incident_updates` object, choose the update with the greatest valid timestamp, and use the final normalized update only when every update lacks a valid timestamp.

Map fields exactly:

- `page.id` → `page.id` and require it.
- `page.status_indicator` → `page.statusIndicator`.
- `page.status_description` → `page.statusDescription`.
- Incident: `id`, `name`, `status`, `impact`, `shortlink`, `created_at`, `updated_at`.
- Incident update: `id`, `body`, `status`, `display_at`, `created_at`, `updated_at`.
- Component: `id`, `name`, `status`.
- Component update: `id`, `old_status`, `new_status`, `created_at`.

Return incident first when `incident` is an object. Return component only when both `component` and `component_update` are objects. Otherwise return the ignored result. Never retain `meta.unsubscribe`, organization IDs, Twitter fields, or the full incident history in the Queue envelope.

- [ ] **Step 5: Verify normalization**

Run:

```bash
npm test -- test/webhook.test.ts
npm run typecheck
```

Expected: four normalization tests PASS; type checking exits `0`.

- [ ] **Step 6: Commit Statuspage normalization**

```bash
git add src/webhook.ts test/webhook.test.ts test/fixtures/incident.json test/fixtures/component-update.json
git commit -m "feat: normalize Statuspage webhook events"
```

---

### Task 4: Authenticate, size-limit, and enqueue webhook requests

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

**Interfaces:**
- Consumes: `normalizeStatuspagePayload()` and `WebhookValidationError` from `src/webhook.ts`.
- Consumes: `WorkerEnv` and `FetchDependencies` from `src/types.ts`.
- Produces: `MAX_WEBHOOK_BODY_BYTES = 131072`.
- Produces: `secureEqual(provided: string, expected: string): Promise<boolean>`.
- Produces: complete `handleFetch()` producer behavior.

- [ ] **Step 1: Add failing webhook producer tests**

Extend `test/index.test.ts` with a `webhook route` describe block. Update the existing imports and add mock cleanup:

```ts
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { handleFetch, secureEqual } from "../src/index";
import incidentPayload from "./fixtures/incident.json";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

afterEach(() => vi.restoreAllMocks());
```

Use `vi.spyOn(env.NOTIFICATION_QUEUE, "send")` and cover these exact cases:

```ts
it("rejects a missing token without enqueueing", async () => {
  const send = vi.spyOn(env.NOTIFICATION_QUEUE, "send");
  const response = await dispatchWebhook(incidentPayload, "");
  expect(response.status).toBe(401);
  expect(send).not.toHaveBeenCalled();
});

it("queues a normalized event and returns 202", async () => {
  const send = vi.spyOn(env.NOTIFICATION_QUEUE, "send").mockResolvedValue({
    metadata: {
      metrics: {
        backlogCount: 0,
        backlogBytes: 0,
        oldestMessageTimestamp: 0,
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
```

Also add tests for:

- wrong token → `401` and no Queue call;
- `GET /webhook` → `405`;
- malformed JSON → `400`;
- valid JSON without `page.id` → `400`;
- authenticated unsupported payload → `202` with `{ queued: false, reason: "unsupported_event" }` and no Queue call;
- body larger than 131072 bytes → `413`;
- unknown path containing a valid token → `404` without logging or echoing the token;
- `secureEqual("same", "same")` is true and unequal strings are false.

Use this helper so the received time is deterministic:

```ts
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
```

- [ ] **Step 2: Run producer tests and confirm failure**

Run:

```bash
npm test -- test/index.test.ts
```

Expected: new webhook tests FAIL because `/webhook` still returns `404` and `secureEqual` is not exported.

- [ ] **Step 3: Implement fixed-time digest comparison**

Add to `src/index.ts`:

```ts
const encoder = new TextEncoder();

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

export async function secureEqual(
  provided: string,
  expected: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([
    sha256Bytes(provided),
    sha256Bytes(expected),
  ]);
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
```

Do not log either input.

- [ ] **Step 4: Implement bounded JSON reading and webhook dispatch**

Add:

```ts
export const MAX_WEBHOOK_BODY_BYTES = 128 * 1024;

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(bytes) && bytes > MAX_WEBHOOK_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new BodyTooLargeError();
  }

  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new InvalidJsonError();
  }
}
```

Update route order exactly:

1. Handle `/health` as Task 1 specifies.
2. Return `404` for paths other than `/webhook`.
3. Return `405` when `/webhook` is not `POST`.
4. Validate query token and return generic `401` on mismatch.
5. Map `BodyTooLargeError` to `413`, `InvalidJsonError` and `WebhookValidationError` to `400`.
6. Normalize using `deps.now().toISOString()`.
7. Return `202` ignored without Queue publication for unsupported payloads.
8. Await `env.NOTIFICATION_QUEUE.send(envelope, { contentType: "json" })`.
9. Return `202` queued on success and generic `503` on rejection.

Use these response bodies:

```ts
{ ok: true, queued: true }
{ ok: true, queued: false, reason: "unsupported_event" }
{ ok: false, error: "unauthorized" }
{ ok: false, error: "invalid_payload" }
{ ok: false, error: "payload_too_large" }
{ ok: false, error: "queue_unavailable" }
```

- [ ] **Step 5: Verify the webhook producer**

Run:

```bash
npm test -- test/index.test.ts test/webhook.test.ts
npm run typecheck
```

Expected: all route, auth, size, normalization, ignored, Queue-success, and Queue-failure tests PASS.

- [ ] **Step 6: Commit the secure producer**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: authenticate and queue webhooks"
```

---

### Task 5: Format safe Chinese Telegram HTML

**Files:**
- Create: `src/formatter.ts`
- Create: `test/formatter.test.ts`

**Interfaces:**
- Consumes: `NormalizedStatuspageEvent` and `StatuspageConfig` from `src/types.ts`.
- Produces: `TELEGRAM_SAFE_LENGTH = 3900`.
- Produces: `escapeHtml(value: string): string`.
- Produces: `formatTelegramMessage(event, pageConfig, timezone): string`.

- [ ] **Step 1: Write failing formatter tests**

Create `test/formatter.test.ts`. Normalize the two fixture payloads through `normalizeStatuspagePayload()` with this complete setup:

```ts
import { describe, expect, it } from "vitest";
import type {
  NormalizedComponentEvent,
  NormalizedIncidentEvent,
  NormalizedStatuspageEvent,
} from "../src/types";
import {
  TELEGRAM_SAFE_LENGTH,
  formatTelegramMessage,
} from "../src/formatter";
import { normalizeStatuspagePayload } from "../src/webhook";
import componentPayload from "./fixtures/component-update.json";
import incidentPayload from "./fixtures/incident.json";

function acceptedEvent(payload: unknown): NormalizedStatuspageEvent {
  const result = normalizeStatuspagePayload(
    payload,
    "2026-08-24T05:00:00.000Z",
  );
  if (result.kind !== "accepted") throw new Error("expected accepted event");
  return result.envelope.event;
}

const incident = acceptedEvent(incidentPayload);
const component = acceptedEvent(componentPayload);
if (incident.type !== "incident") throw new Error("expected incident");
if (component.type !== "component") throw new Error("expected component");
const incidentEvent: NormalizedIncidentEvent = incident;
const componentEvent: NormalizedComponentEvent = component;

it("formats a critical incident in Chinese", () => {
  const text = formatTelegramMessage(
    incidentEvent,
    { name: "示例服务状态", url: "https://status.example.com" },
    "Asia/Shanghai",
  );
  expect(text).toContain("🔴");
  expect(text).toContain("示例服务状态");
  expect(text).toContain("重大事件");
  expect(text).toContain("<b>状态：</b>监控中");
  expect(text).toContain("<b>影响：</b>紧急");
  expect(text).toContain("A fix has been implemented");
  expect(text).toContain("2026-08-24 12:07:53");
  expect(text).toContain('href="https://stspg.io/example"');
});

it("formats a component recovery transition", () => {
  const text = formatTelegramMessage(
    componentEvent,
    { name: "示例服务状态" },
    "Asia/Shanghai",
  );
  expect(text).toContain("🟠");
  expect(text).toContain("组件状态更新");
  expect(text).toContain("大面积中断 → 正常");
});

it("escapes all external text and rejects unsafe links", () => {
  const malicious = structuredClone(incidentEvent);
  malicious.incident.name = '<script>alert("x")</script>';
  malicious.incident.latestUpdate = {
    ...malicious.incident.latestUpdate,
    body: "<b>owned</b> & data",
  };
  malicious.incident.shortlink = "javascript:alert(1)";
  const text = formatTelegramMessage(
    malicious,
    { name: "<Admin>", url: "javascript:alert(2)" },
    "Asia/Shanghai",
  );
  expect(text).toContain("&lt;Admin&gt;");
  expect(text).toContain("&lt;script&gt;");
  expect(text).toContain("&lt;b&gt;owned&lt;/b&gt; &amp; data");
  expect(text).not.toContain("javascript:");
});

it("falls back to the raw page id and preserves unknown statuses", () => {
  const event = structuredClone(componentEvent);
  event.update.oldStatus = "mystery_old";
  event.update.newStatus = "mystery_new";
  const text = formatTelegramMessage(event, undefined, "Asia/Shanghai");
  expect(text).toContain("j2mfxwj97wnj");
  expect(text).toContain("mystery_old → mystery_new");
});

it("never emits more than the safe Telegram length", () => {
  const event = structuredClone(incidentEvent);
  event.incident.latestUpdate = {
    ...event.incident.latestUpdate,
    body: "故障详情".repeat(2000),
  };
  const text = formatTelegramMessage(event, { name: "服务" }, "Asia/Shanghai");
  expect(text.length).toBeLessThanOrEqual(TELEGRAM_SAFE_LENGTH);
  expect(text).toContain("…");
});
```

Add table-driven assertions for every component status, incident status, and impact translation listed in the spec, plus green/blue/yellow/orange/red/white severity classes.

- [ ] **Step 2: Run formatter tests and confirm failure**

Run:

```bash
npm test -- test/formatter.test.ts
```

Expected: FAIL because `src/formatter.ts` does not exist.

- [ ] **Step 3: Implement translation, escaping, URL, and date helpers**

Create `src/formatter.ts` with these exact constants:

```ts
export const TELEGRAM_SAFE_LENGTH = 3900;

const componentStatus = {
  operational: "正常",
  degraded_performance: "性能下降",
  partial_outage: "部分中断",
  major_outage: "大面积中断",
  under_maintenance: "维护中",
} as const;

const incidentStatus = {
  investigating: "调查中",
  identified: "已定位",
  monitoring: "监控中",
  resolved: "已解决",
  scheduled: "已计划",
  in_progress: "维护中",
  verifying: "验证中",
  completed: "已完成",
} as const;

const impact = {
  none: "无影响",
  minor: "轻微",
  major: "严重",
  critical: "紧急",
  maintenance: "维护",
} as const;
```

Implement HTML escaping in this order so ampersands are escaped once:

```ts
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
```

Implement `safeHttpUrl()` to return only absolute `http:` or `https:` URLs, `formatTimestamp()` with `Intl.DateTimeFormat("zh-CN", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })`, and normalize the rendered separators to `YYYY-MM-DD HH:mm:ss`.

- [ ] **Step 4: Implement bounded message builders**

Implement `formatTelegramMessage()` as a discriminated-union dispatch to incident and component builders.

Incident output fields, in order:

1. severity emoji, linked/escaped page name, and `重大事件`;
2. event name;
3. translated incident status;
4. translated impact;
5. escaped page status description, falling back to translated/raw page indicator;
6. newest update body;
7. update display/created/updated timestamp, falling back to incident updated/created time;
8. a `查看详情` anchor only for a valid shortlink.

Component output fields, in order:

1. severity emoji, linked/escaped page name, and `组件状态更新`;
2. component name;
3. translated/raw old status, arrow, and translated/raw new status;
4. escaped page status description, falling back to translated/raw page indicator;
5. component-update timestamp.

Determine severity using numeric rank and choose the strongest current signal. For component events, use `update.newStatus`, `component.status`, and the page indicator; do not let the historical `oldStatus` override the recovery's current severity. Map page indicator `critical` to red, `major` to orange, `minor` to yellow, `maintenance` to blue, and `none` to green:

```ts
const severityRank = {
  "⚪": 0,
  "🟢": 1,
  "🔵": 2,
  "🟡": 3,
  "🟠": 4,
  "🔴": 5,
} as const;
```

Map critical impact and `major_outage` to red; major impact and `partial_outage` to orange; degraded/minor/investigating/identified/monitoring to yellow; maintenance/scheduled/in-progress maintenance to blue; operational/resolved/completed/none to green; unknown-only data to white.

Bound names/statuses to 300 plain-text characters and update body to an initial 3000 characters. Build the HTML, then reduce only the update body with binary search until the complete HTML length is at most `TELEGRAM_SAFE_LENGTH`. Append `…` whenever truncation occurs. This avoids cutting an HTML entity or closing tag.

- [ ] **Step 5: Verify formatter behavior**

Run:

```bash
npm test -- test/formatter.test.ts test/webhook.test.ts
npm run typecheck
```

Expected: all translations, severity levels, escaping, safe-link, time-zone, fallback, and length tests PASS.

- [ ] **Step 6: Commit message formatting**

```bash
git add src/formatter.ts test/formatter.test.ts
git commit -m "feat: format Chinese Telegram alerts"
```

---

### Task 6: Add stable fingerprints and KV delivery records

**Files:**
- Create: `src/dedup.ts`
- Create: `test/dedup.test.ts`

**Interfaces:**
- Consumes: `NormalizedStatuspageEvent` and `DeliveryRecord` from `src/types.ts`.
- Produces: `DELIVERY_TTL_SECONDS = 604800`.
- Produces: `fingerprintEvent(event): Promise<string>`.
- Produces: `hashTarget(chatId): Promise<string>`.
- Produces: `deliveryKey(fingerprint, targetHash): string`.
- Produces: `deliveryExists(kv, key): Promise<boolean>`.
- Produces: `recordDelivery(kv, key, record): Promise<void>`.

- [ ] **Step 1: Write failing deduplication tests**

Create `test/dedup.test.ts` with a normalized fixture event and real test KV:

```ts
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
```

Include a fallback test that removes primary IDs, reorders object properties, and expects the same SHA-256 fingerprint.

- [ ] **Step 2: Run dedup tests and confirm failure**

Run:

```bash
npm test -- test/dedup.test.ts
```

Expected: FAIL because `src/dedup.ts` does not exist.

- [ ] **Step 3: Implement deterministic SHA-256 helpers**

Create `src/dedup.ts`:

```ts
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
```

Use these fingerprint bases:

```ts
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
```

Export target hashing directly from the same SHA-256 helper:

```ts
export async function hashTarget(chatId: string): Promise<string> {
  return sha256Hex(chatId);
}
```

Implement delivery-key and KV calls exactly:

```ts
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
```

- [ ] **Step 4: Verify deduplication**

Run:

```bash
npm test -- test/dedup.test.ts
npm run typecheck
```

Expected: fingerprint stability, target redaction, fallback ordering, and KV record tests PASS.

- [ ] **Step 5: Commit deduplication**

```bash
git add src/dedup.ts test/dedup.test.ts
git commit -m "feat: add target delivery deduplication"
```

---

### Task 7: Implement the Telegram `sendMessage` client

**Files:**
- Create: `src/telegram.ts`
- Create: `test/telegram.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `TelegramTarget` from `src/types.ts`.
- Produces in `src/types.ts`: `TelegramSendResult` discriminated union.
- Produces: `sendTelegramMessage(botToken, target, text, fetchImpl?): Promise<TelegramSendResult>`.

- [ ] **Step 1: Add the Telegram result type**

Append to `src/types.ts`:

```ts
export type TelegramSendResult =
  | {
      ok: true;
      messageId?: number;
    }
  | {
      ok: false;
      kind: "network" | "http" | "invalid_response";
      status?: number;
      description: string;
      retryAfter?: number;
    };
```

- [ ] **Step 2: Write failing Telegram client tests**

Create `test/telegram.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { sendTelegramMessage } from "../src/telegram";

const target = { chatId: "-1001234567890", label: "运维群" };

describe("sendTelegramMessage", () => {
  it("calls sendMessage with HTML and disabled previews", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    await expect(
      sendTelegramMessage("bot-token", target, "<b>Alert</b>", fetchImpl),
    ).resolves.toEqual({ ok: true, messageId: 42 });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.telegram.org/botbot-token/sendMessage");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: "-1001234567890",
      text: "<b>Alert</b>",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  it("parses Telegram 429 retry_after", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 37 },
        },
        { status: 429 },
      ),
    );
    await expect(
      sendTelegramMessage("bot-token", target, "alert", fetchImpl),
    ).resolves.toEqual({
      ok: false,
      kind: "http",
      status: 429,
      description: "Too Many Requests",
      retryAfter: 37,
    });
  });

  it("returns a generic network failure without exposing the token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new Error("request to botbot-token failed"),
    );
    const result = await sendTelegramMessage(
      "bot-token",
      target,
      "alert",
      fetchImpl,
    );
    expect(result).toEqual({
      ok: false,
      kind: "network",
      description: "telegram_network_error",
    });
    expect(JSON.stringify(result)).not.toContain("bot-token");
  });

  it("handles malformed Telegram JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("not-json", { status: 502 }),
    );
    await expect(
      sendTelegramMessage("bot-token", target, "alert", fetchImpl),
    ).resolves.toEqual({
      ok: false,
      kind: "invalid_response",
      status: 502,
      description: "telegram_invalid_response",
    });
  });
});
```

Add a test for a valid JSON non-2xx response without `description`; expect `telegram_http_403` for status `403`. Add a test that invalid/negative/non-integer `retry_after` is omitted.

- [ ] **Step 3: Run Telegram tests and confirm failure**

Run:

```bash
npm test -- test/telegram.test.ts
```

Expected: FAIL because `src/telegram.ts` does not exist.

- [ ] **Step 4: Implement the Telegram client**

Create `src/telegram.ts`. Use an injected `fetchImpl` defaulting to global `fetch` and never log inside this module:

```ts
import type {
  TelegramSendResult,
  TelegramTarget,
} from "./types";

interface TelegramApiResponse {
  ok?: unknown;
  result?: { message_id?: unknown };
  description?: unknown;
  parameters?: { retry_after?: unknown };
}

export async function sendTelegramMessage(
  botToken: string,
  target: TelegramTarget,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramSendResult> {
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: target.chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
    });
  } catch {
    return {
      ok: false,
      kind: "network",
      description: "telegram_network_error",
    };
  }
```

Parse JSON in a separate `try/catch`. Return `invalid_response` when parsing fails or the root is not an object. Success requires `response.ok === true` and payload `ok === true`; include `messageId` only when it is an integer.

For failures:

- set `kind: "http"` when JSON is valid;
- include `status: response.status`;
- use a string `description` truncated to 300 characters, otherwise `telegram_http_<status>`;
- include `retryAfter` only when it is an integer from `1` through `86400`.

- [ ] **Step 5: Verify Telegram handling**

Run:

```bash
npm test -- test/telegram.test.ts
npm run typecheck
```

Expected: request-shape, success, 429, generic HTTP, malformed response, and network-redaction tests PASS.

- [ ] **Step 6: Commit the Telegram client**

```bash
git add src/types.ts src/telegram.ts test/telegram.test.ts
git commit -m "feat: send alerts through Telegram bot API"
```

---

### Task 8: Consume Queue messages with fan-out, retry, and structured logs

**Files:**
- Create: `src/consumer.ts`
- Create: `test/consumer.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `loadWorkerConfig`, `formatTelegramMessage`, dedup exports, and `sendTelegramMessage`.
- Produces: `ConsumerDependencies` with injectable `sendTelegram` and `log`.
- Produces: `computeRetryDelay(attempts, failures): number`.
- Produces: `processQueueMessage(message, env, deps?): Promise<void>`.
- Produces: `handleQueue(batch, env, deps?): Promise<void>`.
- Modifies: default Worker export to include a Cloudflare-compatible wrapper around `handleQueue`.

- [ ] **Step 1: Write failing retry-delay and acknowledgement tests**

Create `test/consumer.test.ts` using `createMessageBatch()`, `createExecutionContext()`, `getQueueResult()`, real test KV, and injected Telegram delivery.

Use these imports and build the shared incident envelope explicitly:

```ts
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
import type {
  QueueEventEnvelope,
  TelegramSendResult,
} from "../src/types";
import { normalizeStatuspagePayload } from "../src/webhook";
import incidentPayload from "./fixtures/incident.json";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const normalized = normalizeStatuspagePayload(
  incidentPayload,
  "2026-08-24T05:00:00.000Z",
);
if (normalized.kind !== "accepted") throw new Error("expected accepted event");
const incidentEnvelope: QueueEventEnvelope = normalized.envelope;
```

Define a helper with explicit attempts:

```ts
function batchFor(
  envelope: QueueEventEnvelope,
  attempts = 1,
  id = "message-1",
) {
  return createMessageBatch("statuspage-telegram-notifications", [
    {
      id,
      timestamp: new Date("2026-08-24T05:00:00.000Z"),
      attempts,
      body: envelope,
    },
  ] satisfies ServiceBindingQueueMessage<QueueEventEnvelope>[]);
}
```

Add pure delay tests:

```ts
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
```

Add these Queue behavior tests:

1. Valid config with two targets and two successful Telegram results → both delivery keys exist and message ID is explicitly acknowledged.
2. A delivery key already exists → that target is skipped and the message is acknowledged when remaining targets succeed.
3. First target succeeds and second returns `500` → first delivery key is written and message is explicitly retried.
4. Re-run the same envelope after test 3 → only the unresolved second target is sent; on success the message is acknowledged.
5. Telegram `429` → message is retried and `computeRetryDelay()` returns Telegram's bounded delay.
6. Missing/invalid KV config → no Telegram call and message is retried.
7. KV `get` failure before delivery → no Telegram call and retry.
8. KV `put` failure after Telegram success → retry, documenting the residual duplicate window.
9. Two messages in one batch are decided independently: one acknowledged and one retried.
10. Captured log objects contain event type, page ID, fingerprint, message ID, attempt, action, and target label/hash, but do not contain bot token or full `chatId`.

Use this valid config setup:

```ts
await env.STATUSPAGE_KV.put(
  "config",
  JSON.stringify({
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
  }),
);
```

- [ ] **Step 2: Run consumer tests and confirm failure**

Run:

```bash
npm test -- test/consumer.test.ts
```

Expected: FAIL because `src/consumer.ts` does not exist.

- [ ] **Step 3: Implement retry computation and sanitized logging**

Create `src/consumer.ts` with:

```ts
import { loadWorkerConfig } from "./config";
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
```

Only log plain objects. Target context must be one of:

```ts
{ targetLabel: target.label }
{ targetHash: targetHash.slice(0, 12) }
```

Never include `target.chatId`, `env.TELEGRAM_BOT_TOKEN`, request URLs, or message text.

- [ ] **Step 4: Implement one-message processing**

Implement `processQueueMessage()` with one outer `try/catch` that converts unexpected errors into a message retry. Exact order:

1. Validate envelope `version === 1`; invalid versions log `invalid_envelope` and retry.
2. `loadWorkerConfig(env.STATUSPAGE_KV)` once.
3. Resolve `pageConfig = config.pages[event.page.id]` without rejecting unknown pages.
4. Format one message.
5. Calculate one event fingerprint.
6. Run target operations concurrently with `Promise.all()`.
7. For each target: hash target, build delivery key, read delivery state, skip if present, send Telegram if absent, write delivery record after success.
8. Record `{ sentAt: deps.now().toISOString(), telegramMessageId }` after success.
9. Treat delivery-record write failure as target failure even though Telegram already accepted the message.
10. If all targets are skipped or successful, call `message.ack()` and log `acknowledged`.
11. If any target fails, compute delay, call `message.retry({ delaySeconds })`, and log `retry` with failure count and delay.

Use an internal target result union so failures preserve the `TelegramSendResult` used by `computeRetryDelay()`. Convert KV/config/unexpected errors to a synthetic network-like failure with description codes `kv_read_error`, `kv_write_error`, `config_error`, or `consumer_error`; do not include raw exception messages in public logs.

- [ ] **Step 5: Implement independent batch handling and wire the Worker**

Export:

```ts
export async function handleQueue(
  batch: MessageBatch<QueueEventEnvelope>,
  env: WorkerEnv,
  deps: ConsumerDependencies = defaultDependencies,
): Promise<void> {
  await Promise.all(
    batch.messages.map((message) => processQueueMessage(message, env, deps)),
  );
}
```

Modify `src/index.ts` default export. Keep dependency injection out of Cloudflare's third handler argument by wrapping both exported handlers:

```ts
import { handleQueue } from "./consumer";

export default {
  fetch(
    request: Request,
    env: WorkerEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    return handleFetch(request, env);
  },
  queue(
    batch: MessageBatch<QueueEventEnvelope>,
    env: WorkerEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    return handleQueue(batch, env);
  },
} satisfies ExportedHandler<WorkerEnv, QueueEventEnvelope>;
```

Do not throw after calling `message.ack()` or `message.retry()`; one failed message must not force a retry of the whole batch.

- [ ] **Step 6: Verify Queue delivery and retry behavior**

Run:

```bash
npm test -- test/consumer.test.ts test/dedup.test.ts test/telegram.test.ts
npm run typecheck
```

Expected: acknowledgement, existing-record skip, partial failure, retry recovery, 429, config/KV failures, independent batch decisions, and redacted log tests PASS.

- [ ] **Step 7: Commit the Queue consumer**

```bash
git add src/consumer.ts src/index.ts test/consumer.test.ts
git commit -m "feat: deliver queued alerts with retries"
```

---

### Task 9: Add end-to-end fixture tests and deployment documentation

**Files:**
- Create: `test/worker.integration.test.ts`
- Create: `.dev.vars.example`
- Create: `README.md`
- Modify: files only when integration tests expose a verified defect

**Interfaces:**
- Consumes: public Worker `fetch`, `handleQueue`, fixtures, KV config, and all production modules.
- Produces: a documented fresh-account deployment procedure and producer-to-consumer acceptance tests.

- [ ] **Step 1: Write producer-to-consumer acceptance tests**

Create `test/worker.integration.test.ts`. For both incident and component fixtures:

1. Spy on `env.NOTIFICATION_QUEUE.send()` and return a successful Queue result.
2. Call the real Worker `fetch()` with `POST /webhook?token=test-webhook-secret`.
3. Capture the exact `QueueEventEnvelope` passed to `send()`.
4. Put the example configuration into test KV.
5. Create a real `MessageBatch` containing the captured envelope.
6. Call exported `handleQueue()` with an injected Telegram sender that records target and text and returns unique message IDs.
7. Assert HTTP `202`, Queue message version `1`, explicit Queue acknowledgement, one send per configured target, correct event-specific Chinese text, and delivery keys in KV.
8. Invoke the same Queue envelope a second time and assert zero additional Telegram sends because delivery records exist.

Collect HTTP bodies and injected logger entries in explicit arrays, then add a security assertion:

```ts
const responses: unknown[] = [];
const logs: Array<Record<string, unknown>> = [];
const serialized = JSON.stringify({ responses, logs });
expect(serialized).not.toContain("test-bot-token");
expect(serialized).not.toContain("test-webhook-secret");
expect(serialized).not.toContain("-1001234567890");
```

- [ ] **Step 2: Run the integration acceptance test**

Run:

```bash
npm test -- test/worker.integration.test.ts
```

Expected: both incident and component flows PASS, duplicate reprocessing produces no additional Telegram calls, and security assertions PASS. If this gate fails, stop this task and use the systematic-debugging skill before changing production code; retain the failing assertion as the regression test.

- [ ] **Step 3: Add local secret example**

Create `.dev.vars.example` with explicit non-production values:

```dotenv
TELEGRAM_BOT_TOKEN="local-test-bot-token"
WEBHOOK_SECRET="local-test-webhook-secret"
```

State in README that these values cannot contact Telegram and must never be used in production.

- [ ] **Step 4: Write the complete README**

Create `README.md` with these sections and exact actionable content:

1. **What it does** — one event per webhook, same target list, KV config, Queue retries, best-effort dedup.
2. **Supported events** — incident and component status update.
3. **Requirements and free-tier budget** — Node 22+, Cloudflare account, and Telegram bot. State the documented Workers KV free limits of 100,000 reads/day, 1,000 writes/day, 1,000 deletes/day, 1,000 list requests/day, and 1 GB storage. State the documented Queue free limits of 10,000 operations/day and 24-hour retention, including approximately three Queue operations per normally delivered event and up to one KV delivery write per target.
4. **Install and test**:

   ```bash
   npm install
   npm run cf-typegen
   npm test
   npm run typecheck
   npm run deploy:dry-run
   ```

5. **Authenticate Wrangler**:

   ```bash
   npx wrangler login
   ```

6. **Create resources**:

   ```bash
   npx wrangler kv namespace create statuspage-telegram-config --binding STATUSPAGE_KV --update-config
   npx wrangler queues create statuspage-telegram-notifications --message-retention-period-secs 86400
   npx wrangler queues create statuspage-telegram-dlq --message-retention-period-secs 86400
   ```

   Explain that `--update-config` writes the real KV namespace ID into `wrangler.jsonc`, while Queue names already match the committed config.

7. **Set secrets**:

   ```bash
   openssl rand -hex 32
   npx wrangler secret put WEBHOOK_SECRET
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   ```

   Explain that each `secret put` command prompts for the value and that the random webhook secret must be saved in a password manager.

8. **Find Telegram chat IDs**:

   ```bash
   export TELEGRAM_BOT_TOKEN='123456789:example-token-from-botfather'
   curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" | jq
   ```

   Explain direct-user ID and negative group/supergroup ID extraction, adding the bot to a group, and sending one message before calling `getUpdates`.

9. **Find Statuspage page ID**:

   ```bash
   curl -s https://www.cloudflarestatus.com/api/v2/status.json | jq -r '.page.id'
   ```

   Explain replacing the public Statuspage domain and that unknown IDs still send using the raw ID.

10. **Create and upload config**:

    ```bash
    cp config.example.json config.json
    npx wrangler kv key put config --binding STATUSPAGE_KV --path config.json --remote
    npx wrangler kv key get config --binding STATUSPAGE_KV --text --remote | jq
    ```

    Document every config field, strings for `chatId`, optional labels/URLs/timezone, and eventual consistency.

11. **Deploy and custom domain**:

    ```bash
    npm run deploy
    npx wrangler tail
    ```

    Explain Cloudflare Dashboard → Workers & Pages → Worker → Settings → Domains & Routes → Add Custom Domain. Do not commit a user-specific route.

12. **Subscribe Statuspage pages** — use concrete URL shape:

    ```text
    https://status-alerts.example.com/webhook?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    ```

    Explain that every Statuspage in that deployment uses this same endpoint and that Statuspage requires `2xx` within 30 seconds.

13. **Local development**:

    ```bash
    cp .dev.vars.example .dev.vars
    npx wrangler kv key put config --binding STATUSPAGE_KV --path config.example.json --local
    npm run dev
    curl -i 'http://localhost:8787/health'
    curl -i 'http://localhost:8787/webhook?token=local-test-webhook-secret' \
      -H 'content-type: application/json' \
      --data-binary @test/fixtures/incident.json
    ```

14. **Retries and DLQ** — five retries; 15, 30, 60, 120, 240-second normal sequence before the code's 900-second cap; Telegram `retry_after` bounded to 3600 seconds; successful target skip; free retention 24 hours. Explain inspection through Cloudflare Dashboard Queues → `statuspage-telegram-dlq` → Messages, correcting config/secrets, and manually posting the saved JSON envelope to the primary Queue from the Dashboard within retention.
15. **Security** — no Statuspage signature, query token caveat, secret rotation, no URL logging, HTML escaping, safe links, and no public config API.
16. **Operational limits** — one Queue message per event; successful delivery is normally three Queue operations; N targets can create N KV delivery writes; exactly-once is not guaranteed.
17. **Deploy another domain** — clone/copy deployment config, change Worker `name`, use independent KV/Queue names and secrets, deploy, then attach another custom domain.
18. **Troubleshooting** — `401`, `400`, `413`, `503`, missing config, invalid chat, bot permission, Telegram 429, and DLQ cases.

- [ ] **Step 5: Run the complete verification suite**

Run in this exact order:

```bash
npm test
npm run typecheck
npm run cf-typegen
git diff --exit-code worker-configuration.d.ts
npm run deploy:dry-run
```

Expected:

- all tests PASS;
- both TypeScript checks exit `0`;
- regenerated binding types match the committed file;
- Wrangler produces a dry-run bundle in `dist/` and exits `0`;
- no production Cloudflare resource or Telegram API is contacted by tests.

- [ ] **Step 6: Run secret and incomplete-marker scans**

Run:

```bash
rg -n 'test-bot-token|test-webhook-secret|local-test-bot-token|local-test-webhook-secret' . \
  -g '!test/**' -g '!vitest.config.ts' -g '!.dev.vars.example' -g '!README.md' \
  -g '!docs/**' || true
rg -n -i '\b(T[O]DO|T[B]D|F[I]XME)\b' src test README.md config.example.json wrangler.jsonc || true
git status --short
```

Expected:

- the first scan prints nothing;
- the incomplete-marker scan prints nothing;
- only the intended Task 9 files and verified integration fixes are uncommitted.

- [ ] **Step 7: Commit integration tests and documentation**

```bash
git add test/worker.integration.test.ts .dev.vars.example README.md src test package.json package-lock.json tsconfig.json vitest.config.ts wrangler.jsonc worker-configuration.d.ts config.example.json
git commit -m "docs: add deployment and operations guide"
```

- [ ] **Step 8: Confirm clean final state**

Run:

```bash
git status --short --branch
git log --oneline --decorate -10
```

Expected: clean working tree with the implementation split across the planned focused commits.
