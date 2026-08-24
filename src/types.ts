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
