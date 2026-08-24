import type {
  NormalizedComponentEvent,
  NormalizedIncidentEvent,
  NormalizedStatuspageEvent,
  StatuspageConfig,
} from "./types";

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

const severityRank = {
  "⚪": 0,
  "🟢": 1,
  "🔵": 2,
  "🟡": 3,
  "🟠": 4,
  "🔴": 5,
} as const;

type Severity = keyof typeof severityRank;

const componentSeverity: Record<string, Severity> = {
  operational: "🟢",
  degraded_performance: "🟡",
  partial_outage: "🟠",
  major_outage: "🔴",
  under_maintenance: "🔵",
};

const incidentSeverity: Record<string, Severity> = {
  investigating: "🟡",
  identified: "🟡",
  monitoring: "🟡",
  resolved: "🟢",
  scheduled: "🔵",
  in_progress: "🔵",
  completed: "🟢",
};

const impactSeverity: Record<string, Severity> = {
  none: "🟢",
  minor: "🟡",
  major: "🟠",
  critical: "🔴",
  maintenance: "🔵",
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function formatTimestamp(value: string | undefined, timezone: string): string | undefined {
  if (value === undefined || Number.isNaN(Date.parse(value))) return undefined;

  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .format(new Date(value))
      .replaceAll("/", "-")
      .replace(",", "")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return undefined;
  }
}

function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  return maximumLength === 0 ? "…" : `${value.slice(0, maximumLength - 1)}…`;
}

function bounded(
  value: string | undefined,
  fallback = "未知",
  maximumLength = 300,
): string {
  return truncate(value ?? fallback, maximumLength);
}

function translated(
  value: string | undefined,
  translations: Record<string, string>,
): string {
  if (value === undefined) return "未知";
  return translations[value] ?? value;
}

function strongestSeverity(candidates: Array<Severity | undefined>): Severity {
  return candidates.reduce<Severity>((strongest, candidate) =>
    candidate !== undefined && severityRank[candidate] > severityRank[strongest]
      ? candidate
      : strongest,
  "⚪");
}

function pageName(
  event: NormalizedStatuspageEvent,
  pageConfig: StatuspageConfig | undefined,
  maximumLength: number,
): string {
  return bounded(pageConfig?.name ?? event.page.id, "未知", maximumLength);
}

function pageLink(
  event: NormalizedStatuspageEvent,
  pageConfig: StatuspageConfig | undefined,
  maximumLength: number,
  includeLink: boolean,
): string {
  const name = escapeHtml(pageName(event, pageConfig, maximumLength));
  const url = includeLink ? safeHttpUrl(pageConfig?.url) : undefined;
  return url === undefined ? name : `<a href="${escapeHtml(url)}">${name}</a>`;
}

function pageStatus(event: NormalizedStatuspageEvent, maximumLength: number): string {
  return bounded(
    event.page.statusDescription ?? translated(event.page.statusIndicator, impact),
    "未知",
    maximumLength,
  );
}

function maximumFittingFieldLength(messageAt: (maximumLength: number) => string): number | undefined {
  if (messageAt(0).length > TELEGRAM_SAFE_LENGTH) return undefined;

  let lowerBound = 0;
  let upperBound = 300;
  while (lowerBound < upperBound) {
    const candidateLength = Math.ceil((lowerBound + upperBound) / 2);
    if (messageAt(candidateLength).length <= TELEGRAM_SAFE_LENGTH) {
      lowerBound = candidateLength;
    } else {
      upperBound = candidateLength - 1;
    }
  }
  return lowerBound;
}

function incidentMessage(
  event: NormalizedIncidentEvent,
  pageConfig: StatuspageConfig | undefined,
  timezone: string,
  updateBody: string,
  maximumFieldLength: number,
  includePageLink: boolean,
  includeDetailLink: boolean,
): string {
  const latestUpdate = event.incident.latestUpdate;
  const severity = strongestSeverity([
    impactSeverity[event.incident.impact ?? ""],
    incidentSeverity[event.incident.status ?? ""],
    impactSeverity[event.page.statusIndicator ?? ""],
  ]);
  const timestamp = [
    latestUpdate?.displayAt,
    latestUpdate?.createdAt,
    latestUpdate?.updatedAt,
    event.incident.updatedAt,
    event.incident.createdAt,
  ]
    .map((value) => formatTimestamp(value, timezone))
    .find((value) => value !== undefined) ?? "未知";
  const shortlink = includeDetailLink ? safeHttpUrl(event.incident.shortlink) : undefined;
  const detailLink =
    shortlink === undefined ? "" : `\n<a href="${escapeHtml(shortlink)}">查看详情</a>`;

  return `${severity} ${pageLink(event, pageConfig, maximumFieldLength, includePageLink)}：<b>重大事件</b>

<b>事件：</b>${escapeHtml(bounded(event.incident.name, "未知", maximumFieldLength))}
<b>状态：</b>${escapeHtml(bounded(translated(event.incident.status, incidentStatus), "未知", maximumFieldLength))}
<b>影响：</b>${escapeHtml(bounded(translated(event.incident.impact, impact), "未知", maximumFieldLength))}
<b>页面状态：</b>${escapeHtml(pageStatus(event, maximumFieldLength))}

<b>更新：</b>
${escapeHtml(updateBody)}

<b>时间：</b>${escapeHtml(timestamp)}${detailLink}`;
}

function componentMessage(
  event: NormalizedComponentEvent,
  pageConfig: StatuspageConfig | undefined,
  timezone: string,
  maximumFieldLength: number,
  includePageLink: boolean,
): string {
  const severity = strongestSeverity([
    componentSeverity[event.update.newStatus ?? ""],
    componentSeverity[event.component.status ?? ""],
    impactSeverity[event.page.statusIndicator ?? ""],
  ]);
  const timestamp = formatTimestamp(event.update.createdAt, timezone) ?? "未知";

  return `${severity} ${pageLink(event, pageConfig, maximumFieldLength, includePageLink)}：<b>组件状态更新</b>

<b>组件：</b>${escapeHtml(bounded(event.component.name, "未知", maximumFieldLength))}
<b>状态：</b>${escapeHtml(bounded(translated(event.update.oldStatus, componentStatus), "未知", maximumFieldLength))} → ${escapeHtml(bounded(translated(event.update.newStatus, componentStatus), "未知", maximumFieldLength))}
<b>页面状态：</b>${escapeHtml(pageStatus(event, maximumFieldLength))}
<b>时间：</b>${escapeHtml(timestamp)}`;
}

interface IncidentLayout {
  maximumFieldLength: number;
  includePageLink: boolean;
  includeDetailLink: boolean;
}

function incidentLayout(
  event: NormalizedIncidentEvent,
  pageConfig: StatuspageConfig | undefined,
  timezone: string,
  body: string,
): IncidentLayout {
  let includePageLink = true;
  let includeDetailLink = true;
  const minimumBody = truncate(body, 0);

  while (true) {
    const maximumFieldLength = maximumFittingFieldLength((fieldLength) =>
      incidentMessage(
        event,
        pageConfig,
        timezone,
        minimumBody,
        fieldLength,
        includePageLink,
        includeDetailLink,
      ),
    );
    if (maximumFieldLength !== undefined) {
      return { maximumFieldLength, includePageLink, includeDetailLink };
    }
    if (includeDetailLink) {
      includeDetailLink = false;
    } else if (includePageLink) {
      includePageLink = false;
    } else {
      return { maximumFieldLength: 0, includePageLink, includeDetailLink };
    }
  }
}

function formatIncidentMessage(
  event: NormalizedIncidentEvent,
  pageConfig: StatuspageConfig | undefined,
  timezone: string,
): string {
  const body = event.incident.latestUpdate?.body ?? "未知";
  const layout = incidentLayout(event, pageConfig, timezone, body);
  const messageFor = (updateBody: string) =>
    incidentMessage(
      event,
      pageConfig,
      timezone,
      updateBody,
      layout.maximumFieldLength,
      layout.includePageLink,
      layout.includeDetailLink,
    );
  const initialBody = truncate(body, 3000);
  const initialMessage = messageFor(initialBody);
  if (initialMessage.length <= TELEGRAM_SAFE_LENGTH) return initialMessage;

  let lowerBound = 0;
  let upperBound = initialBody.length;
  while (lowerBound < upperBound) {
    const candidateLength = Math.ceil((lowerBound + upperBound) / 2);
    const candidate = truncate(body, candidateLength);
    if (messageFor(candidate).length <= TELEGRAM_SAFE_LENGTH) {
      lowerBound = candidateLength;
    } else {
      upperBound = candidateLength - 1;
    }
  }

  return messageFor(truncate(body, lowerBound));
}

function formatComponentMessage(
  event: NormalizedComponentEvent,
  pageConfig: StatuspageConfig | undefined,
  timezone: string,
): string {
  let includePageLink = true;
  let maximumFieldLength = maximumFittingFieldLength((fieldLength) =>
    componentMessage(event, pageConfig, timezone, fieldLength, includePageLink),
  );
  if (maximumFieldLength === undefined) {
    includePageLink = false;
    maximumFieldLength = maximumFittingFieldLength((fieldLength) =>
      componentMessage(event, pageConfig, timezone, fieldLength, includePageLink),
    ) ?? 0;
  }

  return componentMessage(
    event,
    pageConfig,
    timezone,
    maximumFieldLength,
    includePageLink,
  );
}

export function formatTelegramMessage(
  event: NormalizedStatuspageEvent,
  pageConfig: StatuspageConfig | undefined,
  timezone: string,
): string {
  return event.type === "incident"
    ? formatIncidentMessage(event, pageConfig, timezone)
    : formatComponentMessage(event, pageConfig, timezone);
}
