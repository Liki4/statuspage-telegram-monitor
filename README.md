# Statuspage Telegram Worker

A production-oriented Cloudflare Worker that receives Atlassian Statuspage webhooks and delivers safe Chinese notifications to one or more Telegram users or groups.

**Documentation:** [中文 Dashboard / Wrangler 部署手册](docs/deployment-zh.md)

## Highlights

- Receives documented Atlassian Statuspage Incident and Component webhooks.
- Sends escaped Chinese Telegram HTML with safe HTTP(S) links and disabled previews.
- Fans each event out to multiple Telegram `chat_id` targets through one bot.
- Uses Cloudflare Queues for asynchronous delivery, retry, and DLQ handling.
- Uses Workers KV for runtime configuration and seven-day target-level delivery records.
- Skips targets that already succeeded when a partially failed Queue message is retried.
- Keeps bot and webhook credentials in Worker Secrets.
- Exposes no public administration or configuration API.
- Uses native Worker APIs with no production runtime dependencies.

## Architecture

```text
Atlassian Statuspage
        │ POST /webhook?token=...
        ▼
Cloudflare Worker fetch handler
        │ normalize one supported event
        ▼
Cloudflare Queue ──────► Dead Letter Queue after five retries
        │
        ▼
Worker queue handler
   ├── Workers KV config
   ├── target-level delivery records
   └── Telegram Bot API ──► user / group / supergroup
```

Every Statuspage in one deployment shares the same Telegram target list. Use separate deployments and resources when different domains need different bots or target sets.

## Statuspage compatibility

The Worker can receive events from any Atlassian Statuspage whose owner exposes the public **Webhook** subscription channel.

| Source | Public Statuspage API | Public webhook subscription | Current support |
| --- | --- | --- | --- |
| Cloudflare | Yes | Yes | Direct webhook |
| GitHub | Yes | Yes | Direct webhook |
| Claude | Yes | Yes | Direct webhook |
| OpenAI | Yes | No | Not directly subscribable |

OpenAI uses a compatible Statuspage API but does not expose a public webhook subscription. Its `page.id` can be stored in KV, but this webhook-only Worker will not receive OpenAI events unless polling support is added later.

API compatibility and webhook availability are separate: a public `/api/v2/status.json` endpoint identifies a page, but only the page owner can enable outbound webhook subscriptions.

## Supported events

- Incident creation and update events.
- Component status update events.
- Authenticated but unsupported verification payloads are acknowledged with HTTP `202` and are not sent to Telegram.

The current version does not poll Statuspage APIs, RSS, or Atom feeds.

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

### Multiple Telegram targets

Add every user or group to the same target array:

```json
{
  "telegram": {
    "targets": [
      { "chatId": "123456789", "label": "administrator" },
      { "chatId": "-1001234567890", "label": "operations group" }
    ]
  }
}
```

Keep `chatId` values as strings and do not duplicate them. The bot must be able to post in every target chat. A failure for one target retries only unfinished targets because successful targets already have delivery records.

## Deploy and custom domain

```bash
npm run deploy
npx wrangler tail
```

After deployment, add a domain in Cloudflare Dashboard: **Workers & Pages** → your Worker → **Settings** → **Domains & Routes** → **Add Custom Domain**. Do not commit a user-specific route to `wrangler.jsonc`. Use `wrangler tail` to inspect the Worker’s sanitized operational logs.

## Subscribe Statuspage pages

For each page that exposes **Subscribe to Updates → Webhook**, use this URL shape:

```text
https://status-alerts.example.com/webhook?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Cloudflare, GitHub, and Claude currently expose compatible public webhook subscriptions. OpenAI does not, so adding its `page.id` to KV alone will not create an event source.

Every subscribed page in one deployment uses the same endpoint and shared webhook secret. Statuspage requires a `2xx` response within 30 seconds; this Worker responds with `202` after Queue acceptance, while Telegram delivery happens asynchronously. Statuspage confirmation payloads that are not Incident or Component events are acknowledged as `unsupported_event` and intentionally produce no Telegram message.

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

The primary Queue is configured for five retries. Normal failures use 15, 30, 60, 120, and 240-second exponential delays before the code’s 900-second cap. Telegram `retry_after` values are bounded to 3600 seconds. A target with a successful delivery record is skipped on retry; free Queue retention is 24 hours.

### Inspect and replay a DLQ message safely

Use a temporary HTTP pull consumer to inspect `statuspage-telegram-dlq`. Do this before the 24-hour retention window expires. The API token needs account-level **Queues: Edit** permission. The pull response contains the Queue lease ID and the normalized event envelope, so store it in a private directory and do not paste it into tickets or chat.

```bash
set -euo pipefail
umask 077
mkdir -p dlq-recovery && cd dlq-recovery

export ACCOUNT_ID='your-cloudflare-account-id'
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"
read -rsp 'Cloudflare API token (Queues Edit): ' CLOUDFLARE_API_TOKEN
echo
export CLOUDFLARE_API_TOKEN

npx wrangler queues consumer http add statuspage-telegram-dlq \
  --batch-size 1 \
  --visibility-timeout-secs 600
npx wrangler queues consumer http list statuspage-telegram-dlq --json

export DLQ_QUEUE_ID="$({ npx wrangler queues info statuspage-telegram-dlq; } | sed -n 's/^Queue ID: //p')"
export PRIMARY_QUEUE_ID="$({ npx wrangler queues info statuspage-telegram-notifications; } | sed -n 's/^Queue ID: //p')"
: "${DLQ_QUEUE_ID:?could not determine DLQ Queue ID}"
: "${PRIMARY_QUEUE_ID:?could not determine primary Queue ID}"

curl --silent --show-error --fail-with-body \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues/${DLQ_QUEUE_ID}/messages/pull" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data '{"batch_size":1,"visibility_timeout":600000}' \
  | tee dlq-pull.json

jq -e '.success == true and (.result.messages | length) == 1' dlq-pull.json
jq -er '.result.messages[0].body' dlq-pull.json > dlq-envelope.json
jq -e '
  .version == 1 and
  (.event.type == "incident" or .event.type == "component") and
  (.event.page.id | type == "string")
' dlq-envelope.json
```

Pulling leases the message for 10 minutes; it does **not** acknowledge or delete it. Preserve `dlq-pull.json` until recovery is complete because it contains `lease_id`. If no message is returned, remove the temporary consumer with the cleanup command below and try again later. If inspection alone is sufficient, do not call the acknowledgement endpoint; let the lease expire so the message becomes visible again.

Before replaying, identify and correct the original failure—for example, upload valid KV config or rotate/fix a Worker secret. Then create a primary-Queue request containing only the saved envelope and submit it as JSON:

```bash
jq -n --slurpfile envelope dlq-envelope.json \
  '{body:$envelope[0],content_type:"json"}' > primary-replay.json

curl --silent --show-error --fail-with-body \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues/${PRIMARY_QUEUE_ID}/messages" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data @primary-replay.json \
  | tee primary-replay-response.json

jq -e '.success == true' primary-replay-response.json
```

Queue acceptance is not delivery confirmation. In another terminal, run `npx wrangler tail` and wait for the replayed event’s structured log to reach `action: "acknowledged"`; also confirm the expected Telegram targets received it. Target-level delivery records normally skip targets that succeeded before the original message entered the DLQ.

Only after successful replay delivery, acknowledge the original DLQ lease so it cannot be replayed again:

```bash
jq -n --arg lease "$(jq -er '.result.messages[0].lease_id' dlq-pull.json)" \
  '{acks:[{lease_id:$lease}],retries:[]}' > dlq-ack.json

curl --silent --show-error --fail-with-body \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues/${DLQ_QUEUE_ID}/messages/ack" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data @dlq-ack.json \
  | tee dlq-ack-response.json

jq -e '.success == true and .result.ackCount == 1' dlq-ack-response.json
npx wrangler queues consumer http remove statuspage-telegram-dlq
rm -f dlq-pull.json dlq-envelope.json primary-replay.json \
  primary-replay-response.json dlq-ack.json dlq-ack-response.json
unset CLOUDFLARE_API_TOKEN
```

If the lease expires before acknowledgement, do not reuse its stale `lease_id`; pull the DLQ message again. Always remove the temporary HTTP pull consumer when finished, including after an aborted recovery. Never acknowledge the DLQ message merely because the primary Queue accepted the replay.

## Project layout

```text
src/index.ts       HTTP webhook producer and Worker entrypoint
src/webhook.ts     Statuspage payload normalization
src/config.ts      KV configuration validation
src/formatter.ts   Chinese Telegram HTML formatting
src/dedup.ts       fingerprints and delivery records
src/telegram.ts    Telegram Bot API client
src/consumer.ts    Queue fan-out, retry, logging, and acknowledgement
test/              unit and Miniflare integration tests
docs/deployment-zh.md
                   Dashboard-first Chinese deployment runbook
```

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
