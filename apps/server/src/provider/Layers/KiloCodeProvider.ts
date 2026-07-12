import {
  type KiloCodeSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  availableKiloCodeModelsFromSessionSetup,
  findKiloCodeModelConfigOption,
  flattenKiloCodeSessionSelectOptions,
  makeKiloCodeAcpRuntime,
  mergeKiloCodeSlashCommands,
  resolveKiloCodeAcpBaseModelId,
} from "../acp/KiloCodeAcpSupport.ts";

const PROVIDER = ProviderDriverKind.make("kilocode");
const KILOCODE_PRESENTATION = {
  displayName: "Kilo Code",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const KILOCODE_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

export const KILOCODE_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [];

type BuildServerProviderInput = Parameters<typeof buildServerProvider>[0];

function buildKiloCodeServerProvider(
  input: Omit<BuildServerProviderInput, "presentation" | "slashCommands">,
): ServerProviderDraft {
  return buildServerProvider({
    presentation: KILOCODE_PRESENTATION,
    slashCommands: KILOCODE_SLASH_COMMANDS,
    ...input,
  });
}

function buildKiloCodeServerProviderWithCommands(
  input: Omit<BuildServerProviderInput, "presentation">,
): ServerProviderDraft {
  return buildServerProvider({
    presentation: KILOCODE_PRESENTATION,
    ...input,
    slashCommands: mergeKiloCodeSlashCommands(KILOCODE_SLASH_COMMANDS, input.slashCommands ?? []),
  });
}

export function buildInitialKiloCodeProviderSnapshot(
  kiloCodeSettings: KiloCodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = kilocodeModelsFromSettings(kiloCodeSettings.customModels);

    if (!kiloCodeSettings.enabled) {
      return buildKiloCodeServerProvider({
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "KiloCode is disabled in Zrode settings.",
        },
      });
    }

    return buildKiloCodeServerProvider({
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking KiloCode CLI availability...",
      },
    });
  });
}

function kilocodeModelsFromSettings(
  _customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  // Kilo accepts only exact model ids advertised by the live ACP session.
  // Zrode custom slugs cannot be validated without discovery and must not be
  // exposed as selectable models.
  return providerModelsFromSettings(builtInModels, PROVIDER, [], EMPTY_CAPABILITIES);
}

export function parseKiloCodeCliVersion(output: string): string | null {
  const match = output.match(/\b(?:v)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? null;
}

function buildKiloCodeDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = findKiloCodeModelConfigOption(configOptions);
  const seen = new Set<string>();
  return flattenKiloCodeSessionSelectOptions(modelOption).flatMap((option) => {
    const slug = resolveKiloCodeAcpBaseModelId(option.value);
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: option.name || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      } satisfies ServerProviderModel,
    ];
  });
}

function buildKiloCodeDiscoveredModelsFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ReadonlyArray<ServerProviderModel> {
  const availableModels = availableKiloCodeModelsFromSessionSetup(sessionSetupResult);
  if (availableModels) {
    const seen = new Set<string>();
    return availableModels.flatMap((model) => {
      const slug = resolveKiloCodeAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return [];
      }
      seen.add(slug);
      return [
        {
          slug,
          name: model.name.trim() || slug,
          isCustom: false,
          capabilities: EMPTY_CAPABILITIES,
        } satisfies ServerProviderModel,
      ];
    });
  }

  return buildKiloCodeDiscoveredModelsFromConfigOptions(sessionSetupResult.configOptions);
}

const discoverKiloCodeModelsViaAcp = (
  kiloCodeSettings: KiloCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeKiloCodeAcpRuntime({
      kiloCodeSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "zrode-provider-probe", version: "0.0.0" },
      authenticateOnSessionAuthFailure: false,
    });
    const started = yield* acp.start();
    let slashCommands = yield* acp.getAvailableCommands;
    // Kilo publishes commands as an asynchronous session/update immediately
    // after setup. Give that notification a small, bounded wall-clock window;
    // repeated scheduler yields race with child-process I/O and are not a wait.
    for (let attempt = 0; slashCommands.length === 0 && attempt < 20; attempt += 1) {
      yield* Effect.sleep(25);
      slashCommands = yield* acp.getAvailableCommands;
    }
    return {
      models: buildKiloCodeDiscoveredModelsFromSessionSetup(started.sessionSetupResult),
      slashCommands,
    };
  }).pipe(Effect.scoped);

const runKiloCodeVersionCommand = (
  kiloCodeSettings: KiloCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = kiloCodeSettings.binaryPath || "kilo";
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

export const checkKiloCodeProviderStatus = Effect.fn("checkKiloCodeProviderStatus")(function* (
  kiloCodeSettings: KiloCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kilocodeModelsFromSettings(kiloCodeSettings.customModels);

  if (!kiloCodeSettings.enabled) {
    return buildKiloCodeServerProvider({
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "KiloCode is disabled in Zrode settings.",
      },
    });
  }

  const versionResult = yield* runKiloCodeVersionCommand(kiloCodeSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("KiloCode CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildKiloCodeServerProvider({
      enabled: kiloCodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Kilo Code CLI (`kilo`) is not installed or not on PATH."
          : "Failed to execute KiloCode CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildKiloCodeServerProvider({
      enabled: kiloCodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kilo Code CLI is installed but timed out while running `kilo --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseKiloCodeCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("KiloCode CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildKiloCodeServerProvider({
      enabled: kiloCodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "KiloCode CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverKiloCodeModelsViaAcp(kiloCodeSettings, environment).pipe(
    Effect.timeoutOption(KILOCODE_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("KiloCode ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildKiloCodeServerProvider({
      enabled: kiloCodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message:
          "Kilo Code CLI is installed, but ACP discovery failed. Run `kilo auth login` and check server logs.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `KiloCode ACP model discovery timed out after ${KILOCODE_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildKiloCodeServerProvider({
      enabled: kiloCodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: `KiloCode ACP model discovery timed out after ${KILOCODE_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const discovered = discoveryExit.value.value;
  const discoveredModels = discovered.models;
  const models =
    discoveredModels.length > 0
      ? kilocodeModelsFromSettings(kiloCodeSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildKiloCodeServerProviderWithCommands({
    enabled: kiloCodeSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovered.slashCommands,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichKiloCodeSnapshot = (input: {
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
      Effect.logWarning("KiloCode version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
