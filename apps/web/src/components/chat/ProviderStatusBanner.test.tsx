import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderStatusBanner } from "./ProviderStatusBanner";

function providerWithMessage(message: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("opencode"),
    driver: ProviderDriverKind.make("opencode"),
    displayName: "OpenCode",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "error",
    auth: { status: "unknown" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    message,
  };
}

describe("ProviderStatusBanner", () => {
  it("normalizes provider-native status errors before rendering", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={providerWithMessage(
          "unexpected status 502 Bad Gateway: <!doctype html><html>private</html>",
        )}
      />,
    );

    expect(markup).toContain("OpenCode status check failed: 502 Bad Gateway.");
    expect(markup).not.toContain("&lt;!doctype html&gt;");
    expect(markup).not.toContain("private");
  });
});
