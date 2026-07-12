import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@t3tools/contracts";

import {
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  grokModelCapabilitiesFromAcpModel,
  parseGrokReasoningEffortsFromHelp,
} from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

describe("buildInitialGrokProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Grok");
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
      expect(snapshot.showInteractionModeToggle).toBe(true);
      expect(snapshot.supportsImageAttachments).toBe(false);
    }),
  );
});

describe("grokModelCapabilitiesFromAcpModel", () => {
  it("publishes reasoning effort only when Grok advertises support", () => {
    expect(
      grokModelCapabilitiesFromAcpModel(
        {
          modelId: "grok-build",
          name: "Grok Build",
        },
        ["low", "medium", "high"],
      ).optionDescriptors,
    ).toEqual([]);

    expect(
      grokModelCapabilitiesFromAcpModel(
        {
          modelId: "grok-4.5",
          name: "Grok 4.5",
          _meta: { supportsReasoningEffort: true, reasoningEffort: "medium" },
        },
        ["low", "medium", "high", "xhigh", "max"],
      ).optionDescriptors,
    ).toEqual([
      expect.objectContaining({
        id: "effort",
        type: "select",
        currentValue: "medium",
        options: [
          { id: "low", label: "low" },
          { id: "medium", label: "medium", isDefault: true },
          { id: "high", label: "high" },
          { id: "xhigh", label: "xhigh" },
          { id: "max", label: "max" },
        ],
      }),
    ]);

    expect(
      grokModelCapabilitiesFromAcpModel(
        {
          modelId: "grok-4.5",
          name: "Grok 4.5",
          _meta: { supportsReasoningEffort: true, reasoningEffort: "high" },
        },
        [],
      ).optionDescriptors,
    ).toEqual([]);
  });
});

describe("parseGrokReasoningEffortsFromHelp", () => {
  it("derives ordered, unique effort values from the installed CLI help format", () => {
    expect(
      parseGrokReasoningEffortsFromHelp(`
Options:
      --effort <LEVEL>
          Effort level [possible values: low, medium, high, xhigh, max, high]
      --output-format <FORMAT>
          Output format [possible values: plain, json]
`),
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("returns no choices when this CLI does not advertise effort values", () => {
    expect(parseGrokReasoningEffortsFromHelp("--reasoning-effort <EFFORT>")).toEqual([]);
    expect(
      parseGrokReasoningEffortsFromHelp(`
      --effort <LEVEL>
          Reasoning effort
      --output-format <FORMAT>
          Output format [possible values: plain, json]
`),
    ).toEqual([]);
    expect(parseGrokReasoningEffortsFromHelp("unrelated output")).toEqual([]);
  });
});

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken grok install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "zrode-grok-version-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "zrode-grok-success-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", 'printf "grok-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );
});
