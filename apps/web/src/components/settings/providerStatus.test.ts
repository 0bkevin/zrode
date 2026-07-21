import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderSummary } from "./providerStatus";

describe("getProviderSummary", () => {
  it("sanitizes status messages from older remote servers", () => {
    const provider: ServerProvider = {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      enabled: true,
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      checkedAt: "2026-07-21T00:00:00.000Z",
      message:
        "request failed: 403 Forbidden; content-type=text/html; body=<html>IP: private</html>",
      models: [],
      slashCommands: [],
      skills: [],
    };

    const summary = getProviderSummary(provider);
    expect(summary.detail).toBe("Codex status check failed: 403 Forbidden.");
    expect(summary.detail).not.toContain("IP:");
  });
});
