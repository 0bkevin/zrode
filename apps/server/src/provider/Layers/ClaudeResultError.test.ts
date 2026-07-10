import { describe, expect, it } from "vite-plus/test";

import { claudeResultErrorMessage } from "./ClaudeResultError.ts";

describe("claudeResultErrorMessage", () => {
  it("skips Claude's internal EDE diagnostic and returns the actionable error", () => {
    expect(
      claudeResultErrorMessage([
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
        "Authentication failed. Sign in again.",
      ]),
    ).toBe("Authentication failed. Sign in again.");
  });

  it("does not expose an HTML error response in the user-facing message", () => {
    expect(
      claudeResultErrorMessage([
        "unexpected status 403 Forbidden: <html><head><title>Denied</title></head></html>",
      ]),
    ).toBe("Claude request failed: 403 Forbidden.");
  });

  it("uses a stable fallback when the SDK only provides internal diagnostics", () => {
    expect(
      claudeResultErrorMessage([
        " ",
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
      ]),
    ).toBe("Claude turn failed.");
  });

  it("preserves ordinary provider errors", () => {
    expect(claudeResultErrorMessage(["  Error: Request was aborted.  "])).toBe(
      "Error: Request was aborted.",
    );
  });
});
