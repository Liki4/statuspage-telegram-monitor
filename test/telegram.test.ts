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

  it("rejects a valid JSON response whose root is not an object", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(["unexpected"], { status: 502 }),
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

  it("omits a non-integer success message ID", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ ok: true, result: { message_id: 42.5 } }),
    );
    await expect(
      sendTelegramMessage("bot-token", target, "alert", fetchImpl),
    ).resolves.toEqual({ ok: true });
  });

  it("uses a generic description for valid HTTP errors without one", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ ok: false }, { status: 403 }),
    );
    await expect(
      sendTelegramMessage("bot-token", target, "alert", fetchImpl),
    ).resolves.toEqual({
      ok: false,
      kind: "http",
      status: 403,
      description: "telegram_http_403",
    });
  });

  it("omits invalid retry_after values", async () => {
    for (const retryAfter of [0, -1, 1.5, 86401, "37", null]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            ok: false,
            description: "Too Many Requests",
            parameters: { retry_after: retryAfter },
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
      });
    }
  });
});
