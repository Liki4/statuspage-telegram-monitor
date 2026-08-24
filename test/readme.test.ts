import { describe, expect, it } from "vitest";

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
