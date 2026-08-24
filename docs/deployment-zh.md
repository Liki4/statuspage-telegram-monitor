# Statuspage Telegram Worker 中文部署手册

本文说明如何将本项目部署到 Cloudflare Workers，并把多个 Atlassian Statuspage 的事件发送到同一个 Telegram 目标。

本次试部署采用以下方案：

| 项目 | 值 |
| --- | --- |
| 部署方式 | Cloudflare Dashboard 手动部署 |
| 测试域名 | `workers.dev` |
| Worker 名称 | `statuspage-telegram-monitor` |
| 时区 | `Asia/Shanghai` |
| Telegram 目标 | 1 个 `chat_id` |
| Statuspage 页面 | Cloudflare、GitHub、OpenAI、Claude |
| KV 命名空间 | `statuspage-telegram-config` |
| 主 Queue | `statuspage-telegram-notifications` |
| DLQ | `statuspage-telegram-dlq` |

文档后半部分同时提供完整的 Wrangler CLI 部署方式。

> 安全提示：不要把 Telegram Bot Token、Webhook Secret 或真实 `chat_id` 提交到 Git、粘贴到工单或发送到聊天中。本文所有敏感字段均使用占位符。

## 1. 工作原理

一次 Statuspage Webhook 的处理流程如下：

1. Statuspage 向 `POST /webhook?token=<WEBHOOK_SECRET>` 发送事件。
2. Worker 校验查询参数中的共享 Secret，并限制请求体为 128 KiB。
3. Worker 将支持的 Incident 或 Component 事件标准化后写入主 Queue。
4. Queue consumer 从 Workers KV 读取页面和 Telegram 目标配置。
5. Worker 生成安全的中文 Telegram HTML，并向目标 `chat_id` 发送消息。
6. 成功目标会写入七天有效的 KV delivery record，避免 Queue 重试时重复发送。
7. 临时失败最多重试五次；耗尽重试后进入 DLQ。

同一部署中的所有 Statuspage 页面共享同一个 Telegram Bot 和目标列表。

## 2. 准备条件

开始前需要：

- 一个可使用 Workers、Workers KV 和 Queues 的 Cloudflare 账号；
- 已启用的 Cloudflare `workers.dev` 子域；
- 一个 Telegram Bot Token；
- 一个可接收消息的 Telegram 用户或群组 `chat_id`；
- Node.js 22 或更高版本；
- 当前项目代码。

检查本地工具：

```bash
node --version
npm --version
```

Node 版本应为 `v22` 或更高。

## 3. 本地验证并生成 Dashboard 部署文件

在项目根目录运行：

```bash
npm install
npm test
npm run typecheck
npm run deploy:dry-run
```

成功后会生成：

```text
dist/index.js
```

这是已打包的单文件 Module Worker。Dashboard 手动部署时应粘贴这个文件，而不是直接粘贴 `src/index.ts`，因为源代码还依赖其他 TypeScript 模块。

每次代码更新后都需要重新运行 `npm run deploy:dry-run`，再把新的 `dist/index.js` 发布到 Dashboard。

## 4. Dashboard：创建 KV 命名空间

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 进入 **Storage & Databases** → **KV**。
3. 点击 **Create a namespace**。
4. 名称填写：

   ```text
   statuspage-telegram-config
   ```

5. 完成创建。

此命名空间将同时保存：

- KV key `config`：页面和 Telegram 目标配置；
- KV key `delivery:v1:...`：目标级投递记录。

不要为 delivery record 单独创建第二个命名空间。

## 5. Dashboard：创建主 Queue 和 DLQ

进入 **Workers & Pages** → **Queues**，依次创建两条 Queue。

### 5.1 主 Queue

```text
statuspage-telegram-notifications
```

如 Dashboard 要求选择消息保留时间，设置为 24 小时。

### 5.2 Dead Letter Queue

```text
statuspage-telegram-dlq
```

同样将消息保留时间设置为 24 小时。

此时先不要给 DLQ 添加普通 Worker consumer。DLQ 主要用于人工检查和恢复失败消息。

## 6. Dashboard：创建 Worker

1. 进入 **Workers & Pages**。
2. 点击 **Create** → **Worker**。
3. Worker 名称填写：

   ```text
   statuspage-telegram-monitor
   ```

4. 先使用默认代码完成创建。
5. 打开该 Worker 的在线编辑器。
6. 删除默认代码。
7. 将本地 `dist/index.js` 的完整内容粘贴进去。
8. 点击 **Deploy**。

`dist/index.js` 最后一行可能包含 source map 注释；即使 Dashboard 中没有上传 `.map` 文件，也不影响 Worker 运行。

## 7. Dashboard：设置运行时兼容日期

打开 Worker 的 **Settings** → **Runtime** 或 **Compatibility**，将 Compatibility Date 设置为：

```text
2026-08-24
```

Dashboard 菜单名称可能随版本略有变化。关键是让生产 Worker 使用与项目 `wrangler.jsonc` 相同的兼容日期。

## 8. Dashboard：添加 Worker Bindings

打开：

```text
Workers & Pages
→ statuspage-telegram-monitor
→ Settings
→ Bindings
```

不同版本的 Dashboard 可能把此页面称为 **Variables and Secrets** 或 **Bindings & Variables**。

### 8.1 KV binding

添加 KV Namespace binding：

| 字段 | 值 |
| --- | --- |
| Variable name | `STATUSPAGE_KV` |
| KV namespace | `statuspage-telegram-config` |

变量名必须完全一致，包括大小写。

### 8.2 Queue producer binding

添加 Queue producer binding：

| 字段 | 值 |
| --- | --- |
| Variable name | `NOTIFICATION_QUEUE` |
| Queue | `statuspage-telegram-notifications` |

Webhook producer 使用该 binding 将事件写入主 Queue。

## 9. Dashboard：设置 Secrets

准备两个 Secret。

### 9.1 生成 Webhook Secret

在本地终端生成 64 位十六进制随机值：

```bash
openssl rand -hex 32
```

将结果保存在密码管理器中，不要写入仓库。

### 9.2 添加 Worker Secrets

在 Worker 的 **Settings** → **Variables and Secrets** 中添加：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Secret | `TELEGRAM_BOT_TOKEN` | 你的 Telegram Bot Token |
| Secret | `WEBHOOK_SECRET` | 刚生成的随机值 |

必须选择 **Secret**，不要保存为普通明文变量。

保存后重新部署或确认 Dashboard 已将设置应用到 Production 环境。

## 10. Dashboard：添加 Queue consumer

打开：

```text
Workers & Pages
→ Queues
→ statuspage-telegram-notifications
→ Consumers
→ Add consumer
```

选择 **Worker** consumer，并选择：

```text
statuspage-telegram-monitor
```

设置：

| 参数 | 值 |
| --- | --- |
| Maximum batch size | `5` |
| Maximum batch timeout | `5 seconds` |
| Maximum retries | `5` |
| Dead letter queue | `statuspage-telegram-dlq` |

保存后，主 Queue 的消息才会触发 Worker 的 `queue()` handler。

检查两种关系都存在：

- Worker 通过 `NOTIFICATION_QUEUE` 成为主 Queue 的 producer；
- 主 Queue 通过 consumer 设置触发 `statuspage-telegram-monitor`。

只有 producer、没有 consumer 时，Webhook 会返回成功，但 Telegram 不会收到消息。

## 11. Dashboard：写入 KV 配置

打开：

```text
Storage & Databases
→ KV
→ statuspage-telegram-config
→ KV Pairs
→ Add entry
```

Key 必须是：

```text
config
```

Value 使用以下 JSON，将 `<YOUR_TELEGRAM_CHAT_ID>` 替换为你的实际 `chat_id`。`chatId` 必须是 JSON 字符串，即使它只包含数字；群组和超级群组通常是负数。

```json
{
  "version": 1,
  "timezone": "Asia/Shanghai",
  "telegram": {
    "targets": [
      {
        "chatId": "<YOUR_TELEGRAM_CHAT_ID>",
        "label": "首次测试目标"
      }
    ]
  },
  "pages": {
    "yh6f0r4529hb": {
      "name": "Cloudflare",
      "url": "https://www.cloudflarestatus.com"
    },
    "kctbh9vrtdwd": {
      "name": "GitHub",
      "url": "https://www.githubstatus.com"
    },
    "01JMDK9XYNY6RXSED6SDWW50WY": {
      "name": "OpenAI",
      "url": "https://status.openai.com"
    },
    "tymt9n04zgry": {
      "name": "Claude",
      "url": "https://status.claude.com"
    }
  }
}
```

保存后重新打开 key，确认：

- JSON 没有注释；
- 没有尾随逗号；
- `version` 是数字 `1`；
- `chatId` 是字符串；
- 四个 `page.id` 完整且大小写一致。

Workers KV 最终一致，更新后可能需要短暂等待才能在所有位置生效。

## 12. Dashboard：确认 workers.dev 地址

打开 Worker 的 **Settings** → **Domains & Routes**，确认 `workers.dev` 路由已启用。

地址应类似：

```text
https://statuspage-telegram-monitor.<YOUR_WORKERS_DEV_SUBDOMAIN>.workers.dev
```

记录实际地址，后续记为：

```text
<WORKER_BASE_URL>
```

例如：

```text
https://statuspage-telegram-monitor.example.workers.dev
```

## 13. 验证健康检查

运行：

```bash
curl --silent --show-error --fail-with-body \
  '<WORKER_BASE_URL>/health' | jq
```

预期：

```json
{
  "ok": true,
  "service": "statuspage-telegram-worker"
}
```

如果返回 404，通常表示 Dashboard 中仍是默认 Worker 代码，或者 `dist/index.js` 没有成功发布。

## 14. 验证 Webhook 鉴权

先使用错误 token：

```bash
curl -i -X POST \
  '<WORKER_BASE_URL>/webhook?token=wrong-token' \
  -H 'content-type: application/json' \
  --data '{}'
```

预期 HTTP 状态：

```text
401 Unauthorized
```

这一步不应创建 Queue 消息，也不应发送 Telegram 通知。

## 15. 发送一次模拟 Statuspage 事件

为避免把 Secret 写入命令历史，可在本地交互输入：

```bash
read -rsp 'WEBHOOK_SECRET: ' WEBHOOK_SECRET
echo
export WEBHOOK_SECRET
```

创建测试事件：

```bash
cat > /tmp/statuspage-worker-test.json <<'JSON'
{
  "page": {
    "id": "yh6f0r4529hb",
    "status_indicator": "minor",
    "status_description": "Minor Service Outage"
  },
  "incident": {
    "id": "manual-deployment-test-001",
    "name": "Statuspage Telegram Worker 部署测试",
    "status": "monitoring",
    "impact": "minor",
    "shortlink": "https://www.cloudflarestatus.com",
    "created_at": "2026-08-24T08:00:00Z",
    "updated_at": "2026-08-24T08:05:00Z",
    "incident_updates": [
      {
        "id": "manual-deployment-update-001",
        "incident_id": "manual-deployment-test-001",
        "status": "monitoring",
        "body": "这是一条人工发送的部署验证消息，不代表 Cloudflare 发生真实故障。",
        "created_at": "2026-08-24T08:05:00Z",
        "updated_at": "2026-08-24T08:05:00Z",
        "display_at": "2026-08-24T08:05:00Z"
      }
    ]
  }
}
JSON
```

发送：

```bash
curl --silent --show-error --fail-with-body \
  -X POST \
  "<WORKER_BASE_URL>/webhook?token=${WEBHOOK_SECRET}" \
  -H 'content-type: application/json' \
  --data-binary @/tmp/statuspage-worker-test.json | jq
```

预期 producer 响应：

```json
{
  "ok": true,
  "queued": true
}
```

数秒后，Telegram 应收到一条带有 Cloudflare 名称的中文测试通知。

同一个测试 payload 再次发送时，目标级 delivery record 可能将其识别为重复事件并跳过。需要再次测试时，请修改：

```text
incident.id
incident_updates[0].id
```

## 16. 查看 Worker 和 Queue 日志

在 Dashboard 打开：

```text
Workers & Pages
→ statuspage-telegram-monitor
→ Logs
```

也可以从 Queue 页面查看消费指标。

成功事件通常会出现经过脱敏的结构化日志：

```text
action: sent
action: acknowledged
```

日志不会包含 Bot Token、Webhook Secret、完整 `chatId` 或原始 Webhook payload。

如果 producer 返回 `202`，但 Telegram 没有消息，优先检查：

1. 主 Queue 是否有 Worker consumer；
2. consumer 是否选择了正确 Worker；
3. KV 中是否存在 key `config`；
4. `TELEGRAM_BOT_TOKEN` 是否正确；
5. Bot 是否有向目标用户或群组发消息的权限；
6. Queue 日志是否出现 `retry` 或 `failed`。

## 17. 订阅四个 Statuspage

四个页面分别打开：

- Cloudflare：<https://www.cloudflarestatus.com>
- GitHub：<https://www.githubstatus.com>
- OpenAI：<https://status.openai.com>
- Claude：<https://status.claude.com>

在每个页面执行：

1. 点击 **Subscribe to Updates**；
2. 选择 **Webhook**；
3. Webhook URL 填写同一个地址：

   ```text
   <WORKER_BASE_URL>/webhook?token=<WEBHOOK_SECRET>
   ```

4. 如页面允许选择组件，选择你希望监控的组件；首次测试可选择全部；
5. 按页面提示完成确认或验证。

四个页面使用相同 Worker URL 和 Secret。Worker 根据 payload 中的 `page.id` 区分来源。

如果某个页面当前没有提供 Webhook 订阅选项，则不能直接接入本 Worker；本项目目前不会轮询 RSS 或 Statuspage API。

## 18. 上线验收清单

部署完成后逐项确认：

- [ ] `GET /health` 返回 HTTP 200；
- [ ] 错误 token 返回 HTTP 401；
- [ ] 正确 token 的测试 Incident 返回 HTTP 202 和 `queued: true`；
- [ ] Telegram 收到中文测试通知；
- [ ] 通知来源显示为 Cloudflare，而不是原始 `page.id`；
- [ ] Queue 日志出现 `sent` 和 `acknowledged`；
- [ ] 重复发送同一事件不会再次通知成功目标；
- [ ] 主 Queue 最大重试次数为 5；
- [ ] 主 Queue 的 DLQ 是 `statuspage-telegram-dlq`；
- [ ] 四个 Statuspage 均已保存 Webhook 订阅；
- [ ] Bot Token、Webhook Secret 和真实 `chat_id` 没有进入仓库。

## 19. 更新 Telegram 目标

要添加第二个用户或群组，只需编辑 KV key `config`：

```json
{
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
  }
}
```

实际配置还必须保留顶层 `version`、`timezone` 和 `pages`。

所有页面会共享更新后的目标列表。KV 更新最终一致，短时间内不同位置可能仍读取旧值。

## 20. 更新或轮换 Secrets

### 20.1 轮换 Webhook Secret

1. 生成新的随机 Secret；
2. 在 Worker Dashboard 更新 `WEBHOOK_SECRET`；
3. 立即更新四个 Statuspage 的 Webhook URL；
4. 验证测试事件；
5. 删除旧 URL 或旧订阅。

更新 Worker Secret 和四个订阅之间存在短暂切换窗口，建议在低风险时段执行。

### 20.2 轮换 Telegram Bot Token

1. 从 BotFather 获取新 Token；
2. 更新 Worker Secret `TELEGRAM_BOT_TOKEN`；
3. 发送一次新的测试事件；
4. 确认 Telegram 投递成功。

## 21. 回滚

如果新代码部署后异常：

1. 打开 Worker 的 **Deployments**；
2. 选择上一个已知正常版本；
3. 执行 **Rollback**；
4. 再次检查 `/health` 和模拟 Webhook。

如果 Queue consumer 持续失败，可临时从主 Queue 的 Consumers 页面禁用或移除 consumer，防止继续消耗重试次数。不要删除主 Queue 或 DLQ，否则会丢失待处理消息。

## 22. DLQ 处理

消息进入 `statuspage-telegram-dlq` 后：

1. 先检查 Worker 日志，确定失败原因；
2. 修复 KV 配置、Bot 权限或 Secret；
3. 在 24 小时保留期内检查 DLQ；
4. 保存标准化事件 envelope；
5. 将 envelope 人工重新写入主 Queue；
6. 确认 Telegram 投递并出现 `acknowledged`；
7. 最后再确认或删除原 DLQ 消息。

完整的安全 HTTP pull、replay 和 acknowledgement 命令见项目根目录 `README.md` 的 **Retries and DLQ** 章节。

## 23. 常见错误

| 现象 | 原因与处理 |
| --- | --- |
| `/health` 返回 404 | Dashboard 仍是默认代码；重新粘贴并部署 `dist/index.js` |
| Webhook 返回 401 | URL token 与 `WEBHOOK_SECRET` 不一致 |
| Webhook 返回 400 | JSON 格式错误，或缺少受支持 Incident/Component 字段 |
| Webhook 返回 413 | payload 超过 128 KiB |
| Webhook 返回 503 | Queue producer binding 缺失或 Queue 不可用 |
| 返回 202 但 Queue 没消息 | 检查 `NOTIFICATION_QUEUE` producer binding |
| Queue 有消息但不消费 | 主 Queue 没有绑定 Worker consumer |
| Queue 一直重试 | 检查 KV `config`、Bot Token、`chat_id` 和 Bot 权限 |
| Telegram 返回 400 | 常见于错误 `chat_id`、Bot 不在群组或无发言权限 |
| Telegram 返回 429 | Worker 会按 Telegram `retry_after` 请求 Queue 重试 |
| 同一测试只通知一次 | 七天 delivery record 正常生效；修改测试事件 ID |
| 页面显示原始 ID | KV `pages` 中没有对应 `page.id`，或 KV 尚未传播 |

---

# Wrangler CLI 部署方式

以下方式适合后续自动化部署。Dashboard 与 Wrangler 不应分别维护两套不同资源；如果资源已经由 Dashboard 创建，请在 Wrangler 配置中引用现有资源，而不要重复创建同名资源。

## 24. Wrangler 登录

```bash
npx wrangler login
npx wrangler whoami
```

## 25. 设置 Worker 名称

将 `wrangler.jsonc` 中的：

```jsonc
"name": "statuspage-telegram-worker"
```

改为：

```jsonc
"name": "statuspage-telegram-monitor"
```

## 26. 创建 KV 和 Queue

全新账号可执行：

```bash
npx wrangler kv namespace create statuspage-telegram-config \
  --binding STATUSPAGE_KV \
  --update-config

npx wrangler queues create statuspage-telegram-notifications \
  --message-retention-period-secs 86400

npx wrangler queues create statuspage-telegram-dlq \
  --message-retention-period-secs 86400
```

如果 Dashboard 已创建这些资源，不要重复创建。应获取现有 KV namespace ID，并将其写入 `wrangler.jsonc` 对应的 `kv_namespaces` 配置。

## 27. 设置 Wrangler Secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

命令会交互读取值，不要把 Secret 直接写在命令行参数中。

## 28. 创建并上传配置

复制示例文件：

```bash
cp config.example.json config.json
```

将 `config.json` 改为第 11 节的四页面配置，然后上传：

```bash
npx wrangler kv key put config \
  --binding STATUSPAGE_KV \
  --path config.json \
  --remote
```

`config.json` 已被 `.gitignore` 忽略，不要强制提交。

## 29. Wrangler 验证和部署

```bash
npm test
npm run typecheck
npm run cf-typegen
git diff --exit-code worker-configuration.d.ts
npm run deploy:dry-run
npm run deploy
```

`wrangler.jsonc` 已包含：

- KV binding `STATUSPAGE_KV`；
- Queue producer binding `NOTIFICATION_QUEUE`；
- 主 Queue consumer；
- 最大 batch size 5；
- 最大 batch timeout 5 秒；
- 最大重试 5 次；
- DLQ `statuspage-telegram-dlq`；
- Observability。

部署后再执行第 13～18 节的验收步骤。

## 30. Dashboard 与 Wrangler 混合维护原则

- Dashboard 适合首次理解资源关系和紧急操作；
- Wrangler 适合可重复部署和版本控制；
- Worker 代码最终应只选择一种主要发布渠道，避免 Dashboard 在线代码和 Git 版本长期漂移；
- KV 配置和 Secrets 可以继续通过 Dashboard 管理；
- 每次 Wrangler 部署前确认 `wrangler.jsonc` 指向正确的现有 KV 和 Queue；
- 不要在不同独立部署之间共享 KV、Queue 或 Secret，除非这是明确设计。
