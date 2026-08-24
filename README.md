# Statuspage Telegram Worker

## What it does

This Cloudflare Worker accepts one supported Statuspage webhook event at a time and publishes one Queue message for it. Every event in a deployment is delivered to the same configured Telegram target list. Runtime configuration lives in Workers KV, Queue retries handle transient delivery failures, and KV delivery records provide best-effort target-level deduplication.

## Supported events

- Incident creation and update events.
- Component status update events.

## Requirements and free-tier budget

Use Node 22 or newer, a Cloudflare account, and a Telegram bot. At the documented Workers KV free tier, the limits are 100,000 reads/day, 1,000 writes/day, 1,000 deletes/day, 1,000 list requests/day, and 1 GB storage. The documented Cloudflare Queues free tier allows 10,000 operations/day with 24-hour retention. A normally delivered event uses approximately three Queue operations (write, read, and delete) and can use up to one KV delivery write per Telegram target.

## Install and test

```bash
npm install
npm run cf-typegen
npm test
npm run typecheck
npm run deploy:dry-run
```

## Authenticate Wrangler

```bash
npx wrangler login
```

## Create resources

```bash
npx wrangler kv namespace create statuspage-telegram-config --binding STATUSPAGE_KV --update-config
npx wrangler queues create statuspage-telegram-notifications --message-retention-period-secs 86400
npx wrangler queues create statuspage-telegram-dlq --message-retention-period-secs 86400
```

`--update-config` writes the real KV namespace ID into `wrangler.jsonc`. The Queue names already match the committed Worker configuration, including its primary producer/consumer and dead-letter Queue settings.

## Set secrets

```bash
openssl rand -hex 32
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

Each `secret put` command prompts for its value. Save the random webhook secret in a password manager; it is the shared credential in every subscribed webhook URL. Never commit either secret.

## Find Telegram chat IDs

```bash
export TELEGRAM_BOT_TOKEN='123456789:example-token-from-botfather'
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" | jq
```

For a direct user, use `message.chat.id`; for a group or supergroup, use its negative `message.chat.id` as a string. Add the bot to a group and send one message in it before calling `getUpdates`, otherwise Telegram has no update containing that group ID. Ensure the bot has permission to post in the target chat.

## Find Statuspage page ID

```bash
curl -s https://www.cloudflarestatus.com/api/v2/status.json | jq -r '.page.id'
```

Replace `www.cloudflarestatus.com` with the public domain of the Statuspage you are subscribing. Unknown page IDs are still delivered, using the raw ID as their display name, so adding a page mapping is not required to avoid an alert.

## Create and upload config

```bash
cp config.example.json config.json
npx wrangler kv key put config --binding STATUSPAGE_KV --path config.json --remote
npx wrangler kv key get config --binding STATUSPAGE_KV --text --remote | jq
```

Do not commit `config.json`. Its `version` must be `1`. `timezone` is optional and defaults to `Asia/Shanghai`; when set, it must be a valid IANA time-zone name. `telegram.targets` must be a non-empty array. Each target has a required string `chatId` (strings preserve negative group IDs and large IDs) and optional `label`, which is only for sanitized operational logging. `pages` maps a Statuspage page ID to an object with required `name` and optional absolute `http` or `https` `url`. KV is eventually consistent, so a config update can take time to reach every location.

## Deploy and custom domain

```bash
npm run deploy
npx wrangler tail
```

After deployment, add a domain in Cloudflare Dashboard: **Workers & Pages** → your Worker → **Settings** → **Domains & Routes** → **Add Custom Domain**. Do not commit a user-specific route to `wrangler.jsonc`. Use `wrangler tail` to inspect the Worker’s sanitized operational logs.

## Subscribe Statuspage pages

Use this URL shape in each Statuspage subscription:

```text
https://status-alerts.example.com/webhook?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Every Statuspage in one deployment uses this same endpoint and shared webhook secret. Statuspage requires a `2xx` response within 30 seconds; this Worker responds with `202` after Queue acceptance, while Telegram delivery happens asynchronously.

## Local development

```bash
cp .dev.vars.example .dev.vars
npx wrangler kv key put config --binding STATUSPAGE_KV --path config.example.json --local
npm run dev
curl -i 'http://localhost:8787/health'
curl -i 'http://localhost:8787/webhook?token=local-test-webhook-secret' \
  -H 'content-type: application/json' \
  --data-binary @test/fixtures/incident.json
```

`.dev.vars.example` contains explicit non-production values. `local-test-bot-token` and `local-test-webhook-secret` cannot contact Telegram and must never be used in production. Keep the copied `.dev.vars` file private.

## Retries and DLQ

The primary Queue is configured for five retries. Normal failures use 15, 30, 60, 120, and 240-second exponential delays before the code’s 900-second cap. Telegram `retry_after` values are bounded to 3600 seconds. A target with a successful delivery record is skipped on retry; free Queue retention is 24 hours. Inspect exhausted messages in Cloudflare Dashboard → **Queues** → `statuspage-telegram-dlq` → **Messages**. Correct the config or secrets, then manually post the saved JSON envelope to the primary Queue from the Dashboard while it remains within retention.

## Security

Statuspage’s documented webhook payload format has no signature, so the shared query token is required. Query tokens can still appear in infrastructure access records; use a long random secret, rotate it by setting a new Worker secret and updating all Statuspage subscriptions, and do not log authenticated URLs. Rotate the Telegram bot token with `wrangler secret put` if it is exposed. The Worker HTML-escapes external text, accepts only safe absolute HTTP(S) links, logs no secrets or full target IDs, and exposes no public config API.

## Operational limits

One supported event produces one Queue message. A successful delivery normally consumes three Queue operations. Sending an event to N targets can create N KV delivery-record writes. Queue delivery is at-least-once and exactly-once delivery is not guaranteed: Telegram can accept a message before a delivery record can be persisted.

## Deploy another domain

Clone or copy the deployment configuration, change the Worker `name`, use independent KV namespace and Queue names, set independent webhook and bot secrets, deploy it, and then attach the other custom domain. Do not share resources or secrets between independently operated domains unless that shared behavior is intentional.

## Troubleshooting

- **401**: the `token` query value is missing or does not match `WEBHOOK_SECRET`; reset the secret and update every Statuspage URL.
- **400**: the JSON is malformed or lacks the fields required by an incident or component update; compare the received payload with the fixture shape.
- **413**: the webhook body exceeds 128 KiB; reduce payload size or contact the source service.
- **503**: Queue publication failed; Statuspage should retry, and check Cloudflare Queue availability and bindings.
- **Missing config**: upload a valid `config` JSON document to `STATUSPAGE_KV` and allow for KV eventual consistency.
- **Invalid chat or bot permission**: confirm the string chat ID, add the bot to the chat, send a message first for `getUpdates`, and grant posting permission.
- **Telegram 429**: the Worker respects bounded `retry_after`; wait for the Queue retry rather than manually resending immediately.
- **DLQ message**: inspect the saved envelope, fix config or secrets, and manually replay it to the primary Queue before the 24-hour retention expires.
