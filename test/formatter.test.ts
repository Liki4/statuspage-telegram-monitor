import { describe, expect, it } from "vitest";
import type {
  NormalizedComponentEvent,
  NormalizedIncidentEvent,
  NormalizedStatuspageEvent,
} from "../src/types";
import {
  escapeHtml,
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

describe("formatTelegramMessage", () => {
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

  it.each([
    ["operational", "正常", "🟢"],
    ["degraded_performance", "性能下降", "🟡"],
    ["partial_outage", "部分中断", "🟠"],
    ["major_outage", "大面积中断", "🔴"],
    ["under_maintenance", "维护中", "🔵"],
  ])("translates component status %s", (status, translation, emoji) => {
    const event = structuredClone(componentEvent);
    event.update.oldStatus = status;
    event.update.newStatus = status;
    event.component.status = status;
    event.page.statusIndicator = undefined;
    const text = formatTelegramMessage(event, undefined, "Asia/Shanghai");
    expect(text).toContain(`${translation} → ${translation}`);
    expect(text).toContain(emoji);
  });

  it.each([
    ["investigating", "调查中", "🟡"],
    ["identified", "已定位", "🟡"],
    ["monitoring", "监控中", "🟡"],
    ["resolved", "已解决", "🟢"],
    ["scheduled", "已计划", "🔵"],
    ["in_progress", "维护中", "🔵"],
    ["verifying", "验证中", "⚪"],
    ["completed", "已完成", "🟢"],
  ])("translates incident status %s", (status, translation, emoji) => {
    const event = structuredClone(incidentEvent);
    event.incident.status = status;
    event.incident.impact = undefined;
    event.page.statusIndicator = undefined;
    const text = formatTelegramMessage(event, undefined, "Asia/Shanghai");
    expect(text).toContain(`<b>状态：</b>${translation}`);
    expect(text).toContain(emoji);
  });

  it.each([
    ["none", "无影响", "🟢"],
    ["minor", "轻微", "🟡"],
    ["major", "严重", "🟠"],
    ["critical", "紧急", "🔴"],
    ["maintenance", "维护", "🔵"],
  ])("translates incident impact %s", (impact, translation, emoji) => {
    const event = structuredClone(incidentEvent);
    event.incident.status = undefined;
    event.incident.impact = impact;
    event.page.statusIndicator = undefined;
    const text = formatTelegramMessage(event, undefined, "Asia/Shanghai");
    expect(text).toContain(`<b>影响：</b>${translation}`);
    expect(text).toContain(emoji);
  });

  it.each([
    ["none", "🟢"],
    ["maintenance", "🔵"],
    ["minor", "🟡"],
    ["major", "🟠"],
    ["critical", "🔴"],
    ["unknown", "⚪"],
  ])("maps page indicator %s to severity %s", (indicator, emoji) => {
    const event = structuredClone(componentEvent);
    event.update.newStatus = undefined;
    event.component.status = undefined;
    event.page.statusIndicator = indicator;
    const text = formatTelegramMessage(event, undefined, "Asia/Shanghai");
    expect(text).toContain(emoji);
  });

  it("escapes HTML special characters once", () => {
    expect(escapeHtml('&<>"')).toBe("&amp;&lt;&gt;&quot;");
  });
});
