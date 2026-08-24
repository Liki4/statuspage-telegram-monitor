import { describe, expect, it } from "vitest";

import deploymentGuide from "../docs/deployment-zh.md?raw";
import readme from "../README.md?raw";

describe("DLQ recovery runbook", () => {
  it("exports the account ID under Wrangler's supported environment variable", () => {
    expect(readme).toContain('export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"');
  });

  it("uses the Queue pull API visibility_timeout field", () => {
    expect(readme).toContain(
      `--data '{"batch_size":1,"visibility_timeout":600000}'`,
    );
    expect(readme).not.toContain('"visibility_timeout_ms":600000');
  });
});

describe("documented Statuspage compatibility", () => {
  it("distinguishes OpenAI API compatibility from public webhook availability", () => {
    expect(readme).toContain(
      "OpenAI uses a compatible Statuspage API but does not expose a public webhook subscription",
    );
    expect(deploymentGuide).toContain("OpenAI 当前未开放公共 Webhook");
    expect(deploymentGuide).not.toContain("四个 Statuspage 均已保存 Webhook 订阅");
  });
});
