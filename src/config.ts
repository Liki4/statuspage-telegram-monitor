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

export function parseWorkerConfig(input: unknown): WorkerConfig {
  const root = record(input, "config");
  if (root.version !== 1) {
    throw new ConfigError("version must equal 1");
  }

  const telegram = record(root.telegram, "telegram");
  if (!Array.isArray(telegram.targets) || telegram.targets.length === 0) {
    throw new ConfigError("telegram.targets must be a non-empty array");
  }

  const targetIds = new Set<string>();
  const targets: TelegramTarget[] = telegram.targets.map((value, index) => {
    const target = record(value, `telegram.targets[${index}]`);
    const chatId = nonEmptyString(target.chatId, `telegram.targets[${index}].chatId`);
    if (targetIds.has(chatId)) {
      throw new ConfigError(`telegram.targets[${index}].chatId must be unique`);
    }
    targetIds.add(chatId);

    const label = target.label === undefined
      ? undefined
      : nonEmptyString(target.label, `telegram.targets[${index}].label`);
    return label === undefined ? { chatId } : { chatId, label };
  });

  const configuredPages = record(root.pages, "pages");
  const pages: Record<string, StatuspageConfig> = {};
  for (const [rawPageId, value] of Object.entries(configuredPages)) {
    const pageId = nonEmptyString(rawPageId, "pages page ID");
    const page = record(value, `pages.${rawPageId}`);
    const name = nonEmptyString(page.name, `pages.${rawPageId}.name`);
    const url = optionalHttpUrl(page.url, `pages.${rawPageId}.url`);
    pages[pageId] = url === undefined ? { name } : { name, url };
  }

  return {
    version: 1,
    timezone: validateTimeZone(root.timezone),
    telegram: { targets },
    pages,
  };
}

export async function loadWorkerConfig(kv: KVNamespace): Promise<WorkerConfig> {
  const value = await kv.get<unknown>("config", "json");
  if (value === null) {
    throw new ConfigError("KV config key is missing");
  }
  return parseWorkerConfig(value);
}
