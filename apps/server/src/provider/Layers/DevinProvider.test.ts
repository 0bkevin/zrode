// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { DevinSettings } from "@t3tools/contracts";

import {
  buildInitialDevinProviderSnapshot,
  checkDevinProviderStatus,
  DEVIN_SLASH_COMMANDS,
  isDevinVersionAtLeast,
  parseDevinCliVersion,
} from "./DevinProvider.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

describe("buildInitialDevinProviderSnapshot", () => {
  it.effect("returns a disabled snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(decodeDevinSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["adaptive"]);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(
        decodeDevinSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Devin");
    }),
  );

  it.effect("includes Devin provider slash commands", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(
        decodeDevinSettings({ enabled: true }),
      );
      const commandNames = snapshot.slashCommands.map((command) => command.name);
      expect(commandNames).toEqual(DEVIN_SLASH_COMMANDS.map((command) => command.name));
      expect(commandNames).toEqual(expect.arrayContaining(["login", "status", "ask", "model"]));
    }),
  );
});

describe("parseDevinCliVersion", () => {
  it("extracts Devin date-build versions", () => {
    expect(parseDevinCliVersion("devin 2026.4.9-0")).toBe("2026.4.9-0");
    expect(parseDevinCliVersion("Devin CLI 2026.04.10")).toBe("2026.04.10");
    expect(parseDevinCliVersion("no version")).toBeNull();
  });
});

describe("isDevinVersionAtLeast", () => {
  it("compares Devin ACP minimum versions", () => {
    expect(isDevinVersionAtLeast("2026.4.9-0")).toBe(true);
    expect(isDevinVersionAtLeast("2026.4.10-0")).toBe(true);
    expect(isDevinVersionAtLeast("2026.4.8-99")).toBe(false);
    expect(isDevinVersionAtLeast(null)).toBeUndefined();
  });
});

it.layer(NodeServices.layer)("checkDevinProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinProviderStatus(
        decodeDevinSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/devin-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports old versions as unsupported for ACP", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "zrode-devin-old-version-" });
          const devinPath = path.join(dir, "devin");
          yield* fs.writeFileString(
            devinPath,
            ["#!/bin/sh", 'printf "devin 2026.4.8-99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(devinPath, 0o755);

          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.version).toBe("2026.4.8-99");
      expect(snapshot.message).toContain("too old");
    }),
  );

  it.effect(
    "marks a healthy CLI ready without forcing ACP model discovery when no API key exists",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: "zrode-devin-version-" });
            const devinPath = path.join(dir, "devin");
            yield* fs.writeFileString(
              devinPath,
              [
                "#!/bin/sh",
                'if [ "$1" = "--version" ]; then',
                '  printf "devin 2026.4.9-0\\n"',
                "  exit 0",
                "fi",
                'printf "unexpected command: %s\\n" "$*" >&2',
                "exit 9",
                "",
              ].join("\n"),
            );
            yield* fs.chmod(devinPath, 0o755);

            return yield* checkDevinProviderStatus(
              decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
              {},
            );
          }),
        );

        expect(snapshot.enabled).toBe(true);
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("unknown");
        expect(snapshot.models.map((model) => model.slug)).toEqual(["adaptive"]);
        expect(snapshot.slashCommands.map((command) => command.name)).toEqual(
          expect.arrayContaining(["login", "status", "ask"]),
        );
      }),
  );

  it.effect("marks successful WINDSURF_API_KEY ACP discovery as authenticated", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "zrode-devin-acp-discovery-" });
          const devinPath = path.join(dir, "devin");
          yield* fs.writeFileString(
            devinPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then',
              '  printf "devin 2026.4.9-0\\n"',
              "  exit 0",
              "fi",
              'if [ "$1" = "acp" ]; then',
              "  export ZRODE_ACP_EMIT_AVAILABLE_COMMANDS_ON_SESSION_NEW=1",
              `  exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(mockAgentPath)} "$@"`,
              "fi",
              'printf "unexpected command: %s\\n" "$*" >&2',
              "exit 9",
              "",
            ].join("\n"),
          );
          yield* fs.chmod(devinPath, 0o755);

          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            {
              WINDSURF_API_KEY: "secret",
              ZRODE_ACP_EMIT_AVAILABLE_COMMANDS_ON_SESSION_NEW: "1",
            },
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toMatchObject({
        status: "authenticated",
        type: "api-key",
        label: "WINDSURF_API_KEY",
      });
      expect(snapshot.slashCommands).toEqual(
        expect.arrayContaining([
          { name: "launch", description: "Launch a Devin task", input: { hint: "task" } },
          { name: "status", description: "Show status from ACP" },
        ]),
      );
    }),
  );
});
