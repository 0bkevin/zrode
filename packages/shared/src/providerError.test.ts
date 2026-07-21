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

  it("strips an HTML response body included after HTTP response metadata", () => {
    expect(
      normalizeProviderErrorMessage(
        "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 403 Forbidden; content-type=text/html; charset=UTF-8; body=<html><body>IP: private; Ray ID: private</body></html>",
        {
          fallback: "Failed to fetch Codex usage.",
          requestSubject: "Codex usage request",
        },
      ),
    ).toBe("Codex usage request failed: 403 Forbidden.");
  });

  it("does not expose non-HTML response bodies or malformed markup", () => {
    expect(
      normalizeProviderErrorMessage(
        'request failed: 502 Bad Gateway; content-type=application/json; body={"token":"private"}',
        { requestSubject: "Provider usage request" },
      ),
    ).toBe("Provider usage request failed: 502 Bad Gateway.");
    expect(
      normalizeProviderErrorMessage("response body=<script>private diagnostic</script>", {
        fallback: "Usage data could not be loaded.",
      }),
    ).toBe("Usage data could not be loaded.");
    expect(
      normalizeProviderErrorMessage(
        "request failed: 403 Forbidden Ray ID private; body=<html>private</html>",
        { requestSubject: "Provider usage request" },
      ),
    ).toBe("Provider usage request failed: 403.");
  });

  it("compacts and bounds ordinary provider errors", () => {
    expect(normalizeProviderErrorMessage("First line\n\nSecond line")).toBe(
      "First line Second line",
    );
    expect(normalizeProviderErrorMessage("0123456789", { maxLength: 6 })).toBe("01234…");
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
