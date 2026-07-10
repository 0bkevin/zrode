import { describe, expect, it } from "vite-plus/test";

import {
  isInternalProviderDiagnosticMessage,
  normalizeProviderErrorMessage,
} from "./providerError.ts";

describe("normalizeProviderErrorMessage", () => {
  it("replaces internal provider diagnostics with a stable fallback", () => {
    const diagnostic = "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null";

    expect(isInternalProviderDiagnosticMessage(diagnostic)).toBe(true);
    expect(
      normalizeProviderErrorMessage(diagnostic, {
        fallback: "Claude turn failed.",
      }),
    ).toBe("Claude turn failed.");
  });

  it("reduces HTML-backed HTTP failures to their status for every provider", () => {
    expect(
      normalizeProviderErrorMessage(
        "unexpected status 403 Forbidden: <html><head><title>Denied</title></head></html>",
      ),
    ).toBe("Provider request failed: 403 Forbidden.");
    expect(
      normalizeProviderErrorMessage(
        "Provider adapter request failed (opencode) for session/prompt: unexpected status code 502 Bad Gateway: <!doctype html><html></html>",
        { requestSubject: "OpenCode request" },
      ),
    ).toBe("OpenCode request failed: 502 Bad Gateway.");
  });

  it("does not expose a bare HTML document", () => {
    expect(
      normalizeProviderErrorMessage("<!DOCTYPE html><html>private response</html>", {
        fallback: "The provider returned an invalid response.",
      }),
    ).toBe("The provider returned an invalid response.");
  });

  it("trims and preserves ordinary actionable errors", () => {
    expect(normalizeProviderErrorMessage("  Authentication failed. Sign in again.  ")).toBe(
      "Authentication failed. Sign in again.",
    );
    expect(normalizeProviderErrorMessage("   ")).toBeNull();
    expect(normalizeProviderErrorMessage(null)).toBeNull();
  });
});
