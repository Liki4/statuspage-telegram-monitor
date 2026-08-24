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
