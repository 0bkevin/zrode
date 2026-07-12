import * as NodeOS from "node:os";

import {
  ClaudeSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const DEFAULT_CLAUDE_INSTANCE_ID = defaultInstanceIdForDriver(CLAUDE_DRIVER);
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

function claudeEnvironmentHome(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME?.trim();
  if (home) return home;
  const userProfile = environment.USERPROFILE?.trim();
  if (userProfile) return userProfile;
  const homeDrive = environment.HOMEDRIVE?.trim();
  const homePath = environment.HOMEPATH?.trim();
  if (homeDrive && homePath) return `${homeDrive}${homePath}`;
  return NodeOS.homedir();
}

export interface DefaultClaudeInstanceSettings {
  readonly config: ClaudeSettings;
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * Resolve the configuration used by the actual default Claude instance.
 * Explicit `providerInstances.claudeAgent` settings win over the legacy
 * singleton, matching provider-registry hydration. Invalid or mismatched
 * envelopes are treated as disabled so auxiliary readers never fall through
 * to credentials for a different account.
 */
export function defaultClaudeInstanceSettings(
  settings: ServerSettings,
  baseEnv: NodeJS.ProcessEnv = process.env,
): DefaultClaudeInstanceSettings {
  const instance = settings.providerInstances[DEFAULT_CLAUDE_INSTANCE_ID];
  if (instance === undefined) {
    return { config: settings.providers.claudeAgent, environment: baseEnv };
  }

  if (instance.driver !== CLAUDE_DRIVER) {
    return {
      config: { ...settings.providers.claudeAgent, enabled: false },
      environment: baseEnv,
    };
  }

  const decoded = Option.getOrUndefined(decodeClaudeSettings(instance.config ?? {}));
  if (decoded === undefined) {
    return {
      config: { ...settings.providers.claudeAgent, enabled: false },
      environment: baseEnv,
    };
  }

  return {
    config: { ...decoded, enabled: instance.enabled ?? decoded.enabled },
    environment: mergeProviderInstanceEnvironment(instance.environment, baseEnv),
  };
}

export const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "configDirPath" | "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const configDirPath = config.configDirPath?.trim() ?? "";
  if (configDirPath.length > 0) {
    return path.resolve(expandHomePath(configDirPath));
  }

  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    // Legacy configurations launched Claude with this custom HOME. Keep
    // resolving their existing .claude data without changing how it launches.
    return path.resolve(expandHomePath(homePath), ".claude");
  }

  const environment = baseEnv ?? process.env;
  const inheritedConfigDir = environment.CLAUDE_CONFIG_DIR?.trim();
  return path.resolve(
    inheritedConfigDir && inheritedConfigDir.length > 0
      ? expandHomePath(inheritedConfigDir)
      : path.join(claudeEnvironmentHome(environment), ".claude"),
  );
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "configDirPath" | "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const configDirPath = config.configDirPath?.trim() ?? "";
  if (configDirPath.length > 0) {
    const resolvedConfigDir = yield* resolveClaudeConfigDirPath(config, resolvedBaseEnv);
    return {
      ...resolvedBaseEnv,
      CLAUDE_CONFIG_DIR: resolvedConfigDir,
    };
  }

  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const { CLAUDE_CONFIG_DIR: _inheritedConfigDir, ...legacyEnvironment } = resolvedBaseEnv;
  return {
    ...legacyEnvironment,
    HOME: yield* resolveLegacyClaudeHomePath(homePath),
  };
});

const resolveLegacyClaudeHomePath = Effect.fn("resolveLegacyClaudeHomePath")(function* (
  homePath: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  return path.resolve(expandHomePath(homePath));
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "configDirPath" | "homePath">,
    baseEnv?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    if ((config.configDirPath?.trim().length ?? 0) === 0) {
      const homePath = config.homePath.trim();
      if (homePath.length > 0) {
        return `claude:home:${yield* resolveLegacyClaudeHomePath(homePath)}`;
      }
      if (!(baseEnv ?? process.env).CLAUDE_CONFIG_DIR?.trim()) {
        return `claude:home:${yield* resolveLegacyClaudeHomePath(
          claudeEnvironmentHome(baseEnv ?? process.env),
        )}`;
      }
    }
    const resolvedConfigDir = yield* resolveClaudeConfigDirPath(config, baseEnv);
    return `claude:config:${resolvedConfigDir}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "configDirPath" | "homePath">,
    baseEnv?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedConfigDir = yield* resolveClaudeConfigDirPath(config, baseEnv);
    return `${config.binaryPath}\0${resolvedConfigDir}`;
  },
);
