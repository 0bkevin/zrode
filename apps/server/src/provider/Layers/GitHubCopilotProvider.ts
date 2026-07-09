import {
  type GitHubCopilotSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { resolveGitHubCopilotEnvironmentAuth } from "../acp/GitHubCopilotAcpSupport.ts";

const PROVIDER = ProviderDriverKind.make("githubCopilot");
const GITHUB_COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  badgeLabel: "Preview",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;

const GITHUB_COPILOT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "mai-code-1-flash",
    name: "MAI Code 1 Flash",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function gitHubCopilotModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = GITHUB_COPILOT_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    PROVIDER,
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

export function buildInitialGitHubCopilotProviderSnapshot(
  copilotSettings: GitHubCopilotSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = gitHubCopilotModelsFromSettings(copilotSettings.customModels);

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        presentation: GITHUB_COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in Zrode settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GITHUB_COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking GitHub Copilot CLI availability...",
      },
    });
  });
}

const runGitHubCopilotVersionCommand = (
  copilotSettings: GitHubCopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = copilotSettings.binaryPath || "copilot";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

function resolveGitHubCopilotAuth(environment: NodeJS.ProcessEnv | undefined): ServerProviderAuth {
  // Passive only: cached Copilot / `gh` credentials may be valid, but probing
  // them can prompt. Report env-token auth when visible and otherwise leave
  // the status unknown.
  return resolveGitHubCopilotEnvironmentAuth(environment) ?? { status: "unknown" };
}

export const checkGitHubCopilotProviderStatus = Effect.fn("checkGitHubCopilotProviderStatus")(
  function* (
    copilotSettings: GitHubCopilotSettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = gitHubCopilotModelsFromSettings(copilotSettings.customModels);

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        presentation: GITHUB_COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in Zrode settings.",
        },
      });
    }

    const versionResult = yield* runGitHubCopilotVersionCommand(copilotSettings, environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      yield* Effect.logWarning("GitHub Copilot CLI health check failed.", {
        errorTag: error._tag,
      });
      return buildServerProvider({
        presentation: GITHUB_COPILOT_PRESENTATION,
        enabled: copilotSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
            : "Failed to execute GitHub Copilot CLI health check.",
        },
      });
    }

    if (Option.isNone(versionResult.success)) {
      return buildServerProvider({
        presentation: GITHUB_COPILOT_PRESENTATION,
        enabled: copilotSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message:
            "GitHub Copilot CLI is installed but timed out while running `copilot --version`.",
        },
      });
    }

    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      yield* Effect.logWarning("GitHub Copilot CLI version probe exited with a non-zero status.", {
        exitCode: versionOutput.code,
        stdoutLength: versionOutput.stdout.length,
        stderrLength: versionOutput.stderr.length,
      });
      return buildServerProvider({
        presentation: GITHUB_COPILOT_PRESENTATION,
        enabled: copilotSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "GitHub Copilot CLI is installed but failed to run.",
        },
      });
    }

    return buildServerProvider({
      presentation: GITHUB_COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: resolveGitHubCopilotAuth(environment),
      },
    });
  },
);

export const enrichGitHubCopilotSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("GitHub Copilot version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
