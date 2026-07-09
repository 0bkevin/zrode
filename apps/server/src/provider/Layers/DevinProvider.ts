import {
  type DevinSettings,
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
  availableDevinModelsFromSessionSetup,
  DEVIN_DEFAULT_MODEL,
  DEVIN_DEFAULT_MODEL_NAME,
  findDevinModelConfigOption,
  flattenDevinSessionSelectOptions,
  hasDevinEnvironmentAuth,
  makeDevinAcpRuntime,
  mergeDevinSlashCommands,
  resolveDevinAcpBaseModelId,
} from "../acp/DevinAcpSupport.ts";

const PROVIDER = ProviderDriverKind.make("devin");
const DEVIN_PRESENTATION = {
  displayName: "Devin",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const DEVIN_MIN_ACP_VERSION = "2026.4.9-0";

const DEVIN_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEVIN_DEFAULT_MODEL,
    name: DEVIN_DEFAULT_MODEL_NAME,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export const DEVIN_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  { name: "login", description: "Sign in to Devin" },
  { name: "logout", description: "Sign out of Devin" },
  { name: "status", description: "Show Devin authentication and workspace status" },
  { name: "workspace", description: "Show Devin workspace information" },
  { name: "add-dir", description: "Add a workspace directory", input: { hint: "path" } },
  { name: "undo-add-dir", description: "Remove a workspace directory", input: { hint: "path" } },
  { name: "mode", description: "Change Devin interaction mode", input: { hint: "mode" } },
  { name: "normal", description: "Switch Devin to normal mode" },
  { name: "accept-edits", description: "Switch Devin to accept-edits mode" },
  { name: "ask", description: "Switch Devin to ask mode" },
  { name: "plan", description: "Switch Devin to plan mode" },
  { name: "bypass", description: "Switch Devin to bypass mode" },
  { name: "model", description: "Change Devin model", input: { hint: "model" } },
  { name: "fast", description: "Toggle Devin fast mode" },
  { name: "compact", description: "Compact the Devin session context" },
  { name: "context", description: "Show Devin context usage" },
  { name: "help", description: "Show Devin command help" },
  { name: "bug", description: "Report a Devin issue" },
];

type BuildServerProviderInput = Parameters<typeof buildServerProvider>[0];

function buildDevinServerProvider(
  input: Omit<BuildServerProviderInput, "presentation" | "slashCommands">,
): ServerProviderDraft {
  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    slashCommands: DEVIN_SLASH_COMMANDS,
    ...input,
  });
}

function buildDevinServerProviderWithCommands(
  input: Omit<BuildServerProviderInput, "presentation">,
): ServerProviderDraft {
  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    ...input,
    slashCommands: mergeDevinSlashCommands(DEVIN_SLASH_COMMANDS, input.slashCommands ?? []),
  });
}

export function buildInitialDevinProviderSnapshot(
  devinSettings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = devinModelsFromSettings(devinSettings.customModels);

    if (!devinSettings.enabled) {
      return buildDevinServerProvider({
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in Zrode settings.",
        },
      });
    }

    return buildDevinServerProvider({
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin CLI availability...",
      },
    });
  });
}

function devinModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DEVIN_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    PROVIDER,
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

export function parseDevinCliVersion(output: string): string | null {
  const match = output.match(/\b(\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?)\b/);
  return match?.[1] ?? null;
}

function parseDevinVersionParts(version: string | null | undefined):
  | {
      readonly year: number;
      readonly month: number;
      readonly day: number;
      readonly build: number;
    }
  | undefined {
  const match = version?.trim().match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d+))?$/);
  if (!match) {
    return undefined;
  }
  const [, year, month, day, build] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    build: build === undefined ? 0 : Number(build),
  };
}

export function isDevinVersionAtLeast(
  version: string | null | undefined,
  minimum: string = DEVIN_MIN_ACP_VERSION,
): boolean | undefined {
  const actual = parseDevinVersionParts(version);
  const required = parseDevinVersionParts(minimum);
  if (!actual || !required) {
    return undefined;
  }
  const actualParts = [actual.year, actual.month, actual.day, actual.build];
  const requiredParts = [required.year, required.month, required.day, required.build];
  for (let index = 0; index < actualParts.length; index += 1) {
    const actualPart = actualParts[index]!;
    const requiredPart = requiredParts[index]!;
    if (actualPart > requiredPart) return true;
    if (actualPart < requiredPart) return false;
  }
  return true;
}

function buildDevinDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = findDevinModelConfigOption(configOptions);
  const seen = new Set<string>();
  return flattenDevinSessionSelectOptions(modelOption).flatMap((option) => {
    const slug = resolveDevinAcpBaseModelId(option.value);
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

function buildDevinDiscoveredModelsFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ReadonlyArray<ServerProviderModel> {
  const availableModels = availableDevinModelsFromSessionSetup(sessionSetupResult);
  if (availableModels) {
    const seen = new Set<string>();
    return availableModels.flatMap((model) => {
      const slug = resolveDevinAcpBaseModelId(model.modelId);
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

  return buildDevinDiscoveredModelsFromConfigOptions(sessionSetupResult.configOptions);
}

const discoverDevinModelsViaAcp = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDevinAcpRuntime({
      devinSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "zrode-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    yield* Effect.yieldNow;
    let slashCommands = yield* acp.getAvailableCommands;
    for (let attempt = 0; slashCommands.length === 0 && attempt < 20; attempt += 1) {
      yield* Effect.yieldNow;
      slashCommands = yield* acp.getAvailableCommands;
    }
    return {
      models: buildDevinDiscoveredModelsFromSessionSetup(started.sessionSetupResult),
      slashCommands,
    };
  }).pipe(Effect.scoped);

const runDevinVersionCommand = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath || "devin";
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

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = devinModelsFromSettings(devinSettings.customModels);

  if (!devinSettings.enabled) {
    return buildDevinServerProvider({
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in Zrode settings.",
      },
    });
  }

  const versionResult = yield* runDevinVersionCommand(devinSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildDevinServerProvider({
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Devin CLI (`devin`) is not installed or not on PATH."
          : "Failed to execute Devin CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildDevinServerProvider({
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but timed out while running `devin --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseDevinCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildDevinServerProvider({
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but failed to run.",
      },
    });
  }

  if (isDevinVersionAtLeast(version) === false) {
    return buildDevinServerProvider({
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Devin CLI version ${version} is too old for ACP support. Run \`devin update\` and use ${DEVIN_MIN_ACP_VERSION} or newer.`,
      },
    });
  }

  if (!hasDevinEnvironmentAuth(environment)) {
    return buildDevinServerProvider({
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
      },
    });
  }

  const discoveryExit = yield* discoverDevinModelsViaAcp(devinSettings, environment).pipe(
    Effect.timeoutOption(DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Devin ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildDevinServerProvider({
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message:
          "Devin CLI is installed, but ACP model discovery failed. Check WINDSURF_API_KEY or server logs.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Devin ACP model discovery timed out after ${DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildDevinServerProvider({
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: `Devin ACP model discovery timed out after ${DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const discovered = discoveryExit.value.value;
  const discoveredModels = discovered.models;
  const models =
    discoveredModels.length > 0
      ? devinModelsFromSettings(devinSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildDevinServerProviderWithCommands({
    enabled: devinSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovered.slashCommands,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated", type: "api-key", label: "WINDSURF_API_KEY" },
    },
  });
});

export const enrichDevinSnapshot = (input: {
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
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
