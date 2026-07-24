import { type KiloCodeSettings, type ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  collectSessionConfigOptionValues,
  extractModelConfigId,
  findSessionConfigOption,
} from "./AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const KILOCODE_AUTH_METHOD = "kilo-login";

type KiloCodeAcpRuntimeKiloCodeSettings = Pick<KiloCodeSettings, "binaryPath">;

export interface KiloCodeAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  | "authMethodId"
  | "authenticateOnSessionAuthFailure"
  | "clientCapabilities"
  | "skipAuthenticate"
  | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiloCodeSettings: KiloCodeAcpRuntimeKiloCodeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly authenticateOnSessionAuthFailure?: boolean;
}

export interface KiloCodeAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-session-model" | "set-config-option";
  readonly configId?: string;
}

export function buildKiloCodeAcpSpawnInput(
  kiloCodeSettings: KiloCodeAcpRuntimeKiloCodeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kiloCodeSettings?.binaryPath || "kilo",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKiloCodeAcpRuntime = (
  input: KiloCodeAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKiloCodeAcpSpawnInput(input.kiloCodeSettings, input.cwd, input.environment),
        authMethodId: KILOCODE_AUTH_METHOD,
        skipAuthenticate: true,
        // Kilo's `authenticate(kilo-login)` only validates the method id. It
        // does not perform or refresh login, so retrying a prompt afterwards
        // can duplicate a non-idempotent generation without changing auth.
        authenticateOnSessionAuthFailure: input.authenticateOnSessionAuthFailure ?? false,
        clientCapabilities: {},
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveKiloCodeAcpBaseModelId(
  model: string | null | undefined,
): string | undefined {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizedToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

function isKiloCodeModelConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = normalizedToken(option.id);
  const name = normalizedToken(option.name);
  const category = normalizedToken(option.category);
  return category === "model" || id === "model" || name === "model";
}

export function findKiloCodeModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  modelConfigId?: string | null,
): EffectAcpSchema.SessionConfigOption | undefined {
  if (!configOptions || configOptions.length === 0) {
    return undefined;
  }
  const explicit = modelConfigId
    ? findSessionConfigOption(configOptions, modelConfigId)
    : undefined;
  if (explicit?.type === "select") {
    return explicit;
  }
  return configOptions.find(
    (option) => option.type === "select" && isKiloCodeModelConfigOption(option),
  );
}

export interface KiloCodeSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

export function flattenKiloCodeSessionSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<KiloCodeSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
          } satisfies KiloCodeSessionSelectOption,
        ]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies KiloCodeSessionSelectOption,
        ),
  );
}

export function currentKiloCodeModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const currentModelId = sessionSetupResult.models?.currentModelId?.trim();
  if (currentModelId) {
    return currentModelId;
  }
  const modelConfigId = extractModelConfigId(sessionSetupResult);
  const modelOption = findKiloCodeModelConfigOption(
    sessionSetupResult.configOptions,
    modelConfigId,
  );
  const currentValue = modelOption?.currentValue;
  return typeof currentValue === "string" ? currentValue.trim() || undefined : undefined;
}

export function availableKiloCodeModelsFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ReadonlyArray<EffectAcpSchema.ModelInfo> | undefined {
  const models = sessionSetupResult.models?.availableModels;
  return models && models.length > 0 ? models : undefined;
}

export function mergeKiloCodeSlashCommands(
  baseCommands: ReadonlyArray<ServerProviderSlashCommand>,
  discoveredCommands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const merged = new Map<string, ServerProviderSlashCommand>();
  for (const command of [...baseCommands, ...discoveredCommands]) {
    const name = command.name.trim().replace(/^\/+/, "");
    if (!name) {
      continue;
    }
    const description = command.description?.trim();
    const hint = command.input?.hint.trim();
    merged.set(name, {
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return Array.from(merged.values());
}

interface KiloCodeAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setSessionModel: (modelId: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyKiloCodeAcpModelSelection<E, V>(input: {
  readonly runtime: KiloCodeAcpModelSelectionRuntime;
  readonly requestedModelId: string | null | undefined;
  readonly currentModelId?: string | undefined;
  readonly availableModels?: ReadonlyArray<EffectAcpSchema.ModelInfo> | undefined;
  readonly modelConfigId?: string | undefined;
  readonly mapError: (context: KiloCodeAcpModelSelectionErrorContext) => E;
  readonly unsupportedModelError: (
    requestedModelId: string,
    supportedModelIds: ReadonlyArray<string>,
  ) => V;
}): Effect.Effect<string | undefined, E | V> {
  return Effect.gen(function* () {
    const requestedModelId = input.requestedModelId
      ? resolveKiloCodeAcpBaseModelId(input.requestedModelId)
      : undefined;
    if (!requestedModelId) {
      return input.currentModelId;
    }
    if (requestedModelId === input.currentModelId) {
      return input.currentModelId;
    }

    const availableModelIds = (input.availableModels ?? [])
      .map((model) => model.modelId.trim())
      .filter((modelId) => modelId.length > 0);
    if (availableModelIds.includes(requestedModelId)) {
      yield* input.runtime.setSessionModel(requestedModelId).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-session-model",
          }),
        ),
      );
      return requestedModelId;
    }

    const configOptions = yield* input.runtime.getConfigOptions;
    const modelOption = findKiloCodeModelConfigOption(configOptions, input.modelConfigId);
    if (!modelOption) {
      return yield* Effect.fail(input.unsupportedModelError(requestedModelId, availableModelIds));
    }

    const supportedValues = collectSessionConfigOptionValues(modelOption)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (!supportedValues.includes(requestedModelId)) {
      return yield* Effect.fail(
        input.unsupportedModelError(
          requestedModelId,
          Array.from(new Set([...availableModelIds, ...supportedValues])),
        ),
      );
    }

    yield* input.runtime.setConfigOption(modelOption.id, requestedModelId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          step: "set-config-option",
          configId: modelOption.id,
        }),
      ),
    );
    return requestedModelId;
  });
}
