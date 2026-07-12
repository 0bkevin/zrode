import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  defaultClaudeInstanceSettings,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeConfigDirPath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it("uses the explicit default instance config and environment before legacy settings", () => {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          claudeAgent: {
            ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
            configDirPath: "/tmp/legacy-claude",
          },
        },
        providerInstances: {
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/tmp/from-env", sensitive: false }],
            config: { configDirPath: "/tmp/default-instance" },
          },
        } as ServerSettings["providerInstances"],
      } satisfies ServerSettings;

      const resolved = defaultClaudeInstanceSettings(settings, { HOME: "/tmp/home" });
      expect(resolved.config.configDirPath).toBe("/tmp/default-instance");
      expect(resolved.environment.CLAUDE_CONFIG_DIR).toBe("/tmp/from-env");
    });

    it.effect("uses Claude's default config directory when no account root is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir(), ".claude");

        expect(yield* resolveClaudeConfigDirPath({ configDirPath: "", homePath: "" })).toBe(
          resolved,
        );
        expect(yield* makeClaudeEnvironment({ configDirPath: "", homePath: "" })).toBe(process.env);
        expect(yield* makeClaudeContinuationGroupKey({ configDirPath: "", homePath: "" })).toBe(
          `claude:home:${path.resolve(NodeOS.homedir())}`,
        );
      }),
    );

    it.effect("uses CLAUDE_CONFIG_DIR without replacing HOME for a configured account", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const configDirPath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");
        const environment = yield* makeClaudeEnvironment({ configDirPath, homePath: "" });

        expect(yield* resolveClaudeConfigDirPath({ configDirPath, homePath: "" })).toBe(resolved);
        expect(environment.CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(environment.HOME).toBe(process.env.HOME);
        expect(yield* makeClaudeContinuationGroupKey({ configDirPath, homePath: "" })).toBe(
          `claude:config:${resolved}`,
        );
        expect(
          yield* makeClaudeCapabilitiesCacheKey({
            binaryPath: "claude",
            configDirPath,
            homePath: "",
          }),
        ).toBe(`claude\0${resolved}`);
      }),
    );

    it.effect("preserves legacy custom HOME behavior and data layout", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const legacyHome = path.resolve(NodeOS.homedir(), ".claude-legacy-home");
        const environment = yield* makeClaudeEnvironment(
          {
            configDirPath: "",
            homePath: legacyHome,
          },
          { ...process.env, CLAUDE_CONFIG_DIR: "/tmp/inherited-claude-config" },
        );

        expect(environment.HOME).toBe(legacyHome);
        expect(environment.CLAUDE_CONFIG_DIR).toBeUndefined();
        expect(yield* resolveClaudeConfigDirPath({ configDirPath: "", homePath: legacyHome })).toBe(
          path.join(legacyHome, ".claude"),
        );
        expect(
          yield* makeClaudeContinuationGroupKey({ configDirPath: "", homePath: legacyHome }),
        ).toBe(`claude:home:${legacyHome}`);
      }),
    );

    it.effect("inherits an explicit CLAUDE_CONFIG_DIR for the default account", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir(), ".claude-inherited");
        const baseEnv = { ...process.env, CLAUDE_CONFIG_DIR: "~/.claude-inherited" };

        expect(
          yield* resolveClaudeConfigDirPath({ configDirPath: "", homePath: "" }, baseEnv),
        ).toBe(resolved);
        expect(
          yield* makeClaudeContinuationGroupKey({ configDirPath: "", homePath: "" }, baseEnv),
        ).toBe(`claude:config:${resolved}`);
      }),
    );

    it.effect("uses the provider environment home when no config directory is set", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const configuredHome = path.resolve("/tmp/claude-account-home");
        const environment = { HOME: configuredHome, USERPROFILE: configuredHome };

        expect(
          yield* resolveClaudeConfigDirPath({ configDirPath: "", homePath: "" }, environment),
        ).toBe(path.resolve(configuredHome, ".claude"));
        expect(
          yield* makeClaudeContinuationGroupKey({ configDirPath: "", homePath: "" }, environment),
        ).toBe(`claude:home:${configuredHome}`);
      }),
    );
  });
});
