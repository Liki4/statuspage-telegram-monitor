import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TELEGRAM_BOT_TOKEN: "test-bot-token",
          WEBHOOK_SECRET: "test-webhook-secret",
        },
        kvNamespaces: ["STATUSPAGE_KV"],
        compatibilityFlags: ["service_binding_extra_handlers"],
        queueConsumers: {
          "statuspage-telegram-notifications": { maxBatchTimeout: 0.05 },
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
