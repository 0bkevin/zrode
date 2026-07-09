import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GitHubCopilotSettings } from "@t3tools/contracts";

import {
  buildInitialGitHubCopilotProviderSnapshot,
  checkGitHubCopilotProviderStatus,
} from "./GitHubCopilotProvider.ts";

const decodeGitHubCopilotSettings = Schema.decodeSync(GitHubCopilotSettings);

describe("buildInitialGitHubCopilotProviderSnapshot", () => {
  it.effect("returns a disabled snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGitHubCopilotProviderSnapshot(
        decodeGitHubCopilotSettings({}),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual(
        expect.arrayContaining(["auto", "claude-sonnet-4.6", "gpt-5.4"]),
      );
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGitHubCopilotProviderSnapshot(
        decodeGitHubCopilotSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking GitHub Copilot");
    }),
  );
});

it.layer(NodeServices.layer)("checkGitHubCopilotProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGitHubCopilotProviderStatus(
        decodeGitHubCopilotSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/copilot-binary",
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
      const secretStderr = "broken copilot install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({
            prefix: "zrode-github-copilot-version-",
          });
          const copilotPath = path.join(dir, "copilot");
          yield* fs.writeFileString(
            copilotPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(copilotPath, 0o755);

          return yield* checkGitHubCopilotProviderStatus(
            decodeGitHubCopilotSettings({ enabled: true, binaryPath: copilotPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("GitHub Copilot CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("marks a healthy CLI ready without starting ACP", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({
            prefix: "zrode-github-copilot-success-",
          });
          const copilotPath = path.join(dir, "copilot");
          yield* fs.writeFileString(
            copilotPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then',
              '  printf "copilot version 1.2.3\\n"',
              "  exit 0",
              "fi",
              'printf "unexpected command: %s\\n" "$*" >&2',
              "exit 9",
              "",
            ].join("\n"),
          );
          yield* fs.chmod(copilotPath, 0o755);

          return yield* checkGitHubCopilotProviderStatus(
            decodeGitHubCopilotSettings({ enabled: true, binaryPath: copilotPath }),
            { GH_TOKEN: "secret" },
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("1.2.3");
      expect(snapshot.auth).toMatchObject({
        status: "authenticated",
        type: "token",
        label: "GH_TOKEN",
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual(
        expect.arrayContaining(["auto", "claude-sonnet-4.6", "gpt-5.4"]),
      );
    }),
  );
});
