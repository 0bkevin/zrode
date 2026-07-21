import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { grokProviderMaintenanceResolver } from "./GrokDriver.ts";

describe("Grok provider maintenance", () => {
  it("uses Grok's documented self-update command for native installations", () => {
    expect(
      grokProviderMaintenanceResolver.resolve({
        binaryPath: "/Users/example/.grok/bin/grok",
        resolvedCommandPath: "/Users/example/.grok/bin/grok",
      }),
    ).toEqual({
      provider: ProviderDriverKind.make("grok"),
      packageName: "@xai-official/grok",
      update: {
        command: "/Users/example/.grok/bin/grok update",
        executable: "/Users/example/.grok/bin/grok",
        args: ["update"],
        lockKey: "grok-native",
      },
    });
  });

  it("uses the official npm package for npm-managed installations", () => {
    expect(
      grokProviderMaintenanceResolver.resolve({
        binaryPath: "/usr/local/lib/node_modules/@xai-official/grok/bin/grok",
        resolvedCommandPath: "/usr/local/lib/node_modules/@xai-official/grok/bin/grok",
      }),
    ).toMatchObject({
      packageName: "@xai-official/grok",
      update: {
        command: "npm install -g @xai-official/grok@latest",
        executable: "npm",
      },
    });
  });
});
