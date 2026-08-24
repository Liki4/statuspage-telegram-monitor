import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request;

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
