import {
  type DevinSettings,
  type ProviderUserInputAnswers,
  type ServerProviderSlashCommand,
  type UserInputQuestion,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import {
  collectSessionConfigOptionValues,
  extractModelConfigId,
  findSessionConfigOption,
} from "./AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const DEVIN_API_KEY_ENV = "WINDSURF_API_KEY";
export const DEVIN_AUTH_METHOD_BROWSER = "devin-browser";
export const DEVIN_DEFAULT_MODEL = "adaptive";
export const DEVIN_DEFAULT_MODEL_NAME = "Adaptive";
const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath">;

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  | "authMethodId"
  | "authenticateOnSessionAuthFailure"
  | "clientCapabilities"
  | "skipAuthenticate"
  | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface DevinAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-session-model" | "set-config-option";
  readonly configId?: string;
}

export function hasDevinEnvironmentAuth(environment: NodeJS.ProcessEnv | undefined): boolean {
  return Boolean(environment?.[DEVIN_API_KEY_ENV]?.trim());
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
        authMethodId: DEVIN_AUTH_METHOD_BROWSER,
        skipAuthenticate: true,
        authenticateOnSessionAuthFailure: true,
        clientCapabilities: {
          elicitation: {
            form: {},
            url: {},
          },
        },
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

export function resolveDevinAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : DEVIN_DEFAULT_MODEL;
  return normalizeModelSlug(base, DEVIN_DRIVER_KIND) ?? DEVIN_DEFAULT_MODEL;
}

function normalizedToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

function isDevinModelConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = normalizedToken(option.id);
  const name = normalizedToken(option.name);
  const category = normalizedToken(option.category);
  return category === "model" || id === "model" || name === "model";
}

export function findDevinModelConfigOption(
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
    (option) => option.type === "select" && isDevinModelConfigOption(option),
  );
}

export interface DevinSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

export function flattenDevinSessionSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<DevinSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
          } satisfies DevinSessionSelectOption,
        ]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies DevinSessionSelectOption,
        ),
  );
}

export function currentDevinModelIdFromSessionSetup(
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
  const modelOption = findDevinModelConfigOption(sessionSetupResult.configOptions, modelConfigId);
  const currentValue = modelOption?.currentValue;
  return typeof currentValue === "string" ? currentValue.trim() || undefined : undefined;
}

export function availableDevinModelsFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ReadonlyArray<EffectAcpSchema.ModelInfo> | undefined {
  const models = sessionSetupResult.models?.availableModels;
  return models && models.length > 0 ? models : undefined;
}

export function mergeDevinSlashCommands(
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

interface DevinAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setSessionModel: (modelId: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: DevinAcpModelSelectionRuntime;
  readonly requestedModelId: string | null | undefined;
  readonly currentModelId?: string | undefined;
  readonly availableModels?: ReadonlyArray<EffectAcpSchema.ModelInfo> | undefined;
  readonly modelConfigId?: string | undefined;
  readonly mapError: (context: DevinAcpModelSelectionErrorContext) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    const requestedModelId = input.requestedModelId
      ? resolveDevinAcpBaseModelId(input.requestedModelId)
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
    const modelOption = findDevinModelConfigOption(configOptions, input.modelConfigId);
    if (!modelOption) {
      return input.currentModelId;
    }

    const supportedValues = collectSessionConfigOptionValues(modelOption)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (!supportedValues.includes(requestedModelId)) {
      return input.currentModelId;
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

function trimmed(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

function elicitationHeader(
  request: EffectAcpSchema.ElicitationRequest,
  fallback = "Input",
): string {
  if (request.mode === "form") {
    return trimmed(request.requestedSchema.title) ?? trimmed(request.message) ?? fallback;
  }
  return trimmed(request.message) ?? fallback;
}

function titledOptions(
  options: ReadonlyArray<EffectAcpSchema.EnumOption> | null | undefined,
): ReadonlyArray<UserInputQuestion["options"][number]> {
  return (options ?? []).flatMap((option) => {
    const value = trimmed(option.const);
    const title = trimmed(option.title);
    if (!value || !title) {
      return [];
    }
    return [{ label: title, description: value }];
  });
}

function stringEnumOptions(
  values: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<UserInputQuestion["options"][number]> {
  return (values ?? []).flatMap((value) => {
    const text = trimmed(value);
    return text ? [{ label: text, description: text }] : [];
  });
}

function fallbackOption(
  property: EffectAcpSchema.ElicitationPropertySchema,
): UserInputQuestion["options"][number] {
  const title = trimmed(property.title) ?? "Provide answer";
  return {
    label: title,
    description: trimmed(property.description) ?? title,
  };
}

function optionsForElicitationProperty(
  property: EffectAcpSchema.ElicitationPropertySchema,
): ReadonlyArray<UserInputQuestion["options"][number]> {
  if (property.type === "string") {
    const fromOneOf = titledOptions(property.oneOf);
    if (fromOneOf.length > 0) {
      return fromOneOf;
    }
    const fromEnum = stringEnumOptions(property.enum);
    return fromEnum.length > 0 ? fromEnum : [fallbackOption(property)];
  }
  if (property.type === "boolean") {
    return [
      { label: "Yes", description: "true" },
      { label: "No", description: "false" },
    ];
  }
  if (property.type === "array") {
    const items = property.items;
    const fromAnyOf = "anyOf" in items ? titledOptions(items.anyOf) : [];
    if (fromAnyOf.length > 0) {
      return fromAnyOf;
    }
    const fromEnum = "enum" in items ? stringEnumOptions(items.enum) : [];
    return fromEnum.length > 0 ? fromEnum : [fallbackOption(property)];
  }
  return [fallbackOption(property)];
}

export function extractDevinElicitationQuestions(
  request: EffectAcpSchema.ElicitationRequest,
): ReadonlyArray<UserInputQuestion> {
  if (request.mode === "url") {
    return [
      {
        id: "url",
        header: elicitationHeader(request, "URL"),
        question: trimmed(request.message) ?? request.url,
        options: [{ label: "Open link", description: request.url }],
      },
    ];
  }

  const properties = request.requestedSchema.properties ?? {};
  const questions = Object.entries(properties).flatMap(([id, property], index) => {
    const questionId = trimmed(id) ?? `field-${index + 1}`;
    const title = trimmed(property.title) ?? questionId;
    const description = trimmed(property.description);
    return [
      {
        id: questionId,
        header: elicitationHeader(request),
        question: description && description !== title ? `${title}: ${description}` : title,
        options: optionsForElicitationProperty(property),
        ...(property.type === "array" ? { multiSelect: true } : {}),
      } satisfies UserInputQuestion,
    ];
  });

  if (questions.length > 0) {
    return questions;
  }

  return [
    {
      id: "response",
      header: elicitationHeader(request),
      question: trimmed(request.message) ?? "Input required",
      options: [{ label: "Continue", description: "Continue" }],
    },
  ];
}

function answerValue(answers: ProviderUserInputAnswers, questionId: string): unknown {
  return answers[questionId];
}

function enumConstForLabel(
  options: ReadonlyArray<EffectAcpSchema.EnumOption> | null | undefined,
  label: string,
): string | undefined {
  return (options ?? []).find((option) => option.title === label || option.const === label)?.const;
}

function normalizeStringAnswer(
  property: Extract<EffectAcpSchema.ElicitationPropertySchema, { readonly type: "string" }>,
  raw: unknown,
): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = trimmed(raw);
  if (!value) {
    return undefined;
  }
  return enumConstForLabel(property.oneOf, value) ?? value;
}

function normalizeBooleanAnswer(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  switch (raw.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "y":
    case "1":
    case "on":
      return true;
    case "false":
    case "no":
    case "n":
    case "0":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function normalizeNumberAnswer(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : undefined;
}

function normalizeArrayAnswer(
  property: Extract<EffectAcpSchema.ElicitationPropertySchema, { readonly type: "array" }>,
  raw: unknown,
): ReadonlyArray<string> | undefined {
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const items = property.items;
  const normalized = values.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const value = trimmed(entry);
    if (!value) {
      return [];
    }
    return "anyOf" in items ? [enumConstForLabel(items.anyOf, value) ?? value] : [value];
  });
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeElicitationContentValue(
  property: EffectAcpSchema.ElicitationPropertySchema,
  raw: unknown,
): EffectAcpSchema.ElicitationContentValue | undefined {
  switch (property.type) {
    case "string":
      return normalizeStringAnswer(property, raw);
    case "boolean":
      return normalizeBooleanAnswer(raw);
    case "number":
      return normalizeNumberAnswer(raw);
    case "integer": {
      const value = normalizeNumberAnswer(raw);
      return value !== undefined && Number.isInteger(value) ? value : undefined;
    }
    case "array":
      return normalizeArrayAnswer(property, raw);
  }
}

export function makeDevinElicitationResponse(
  request: EffectAcpSchema.ElicitationRequest,
  answers: ProviderUserInputAnswers,
): EffectAcpSchema.ElicitationResponse {
  if (request.mode === "url") {
    return { action: { action: "accept" } };
  }

  const properties = request.requestedSchema.properties ?? {};
  const content = Object.fromEntries(
    Object.entries(properties).flatMap(([id, property]) => {
      const value = normalizeElicitationContentValue(property, answerValue(answers, id));
      return value === undefined ? [] : [[id, value] as const];
    }),
  );

  return {
    action: {
      action: "accept",
      ...(Object.keys(content).length > 0 ? { content } : {}),
    },
  };
}

export function makeDevinElicitationCancelledResponse(): EffectAcpSchema.ElicitationResponse {
  return { action: { action: "cancel" } };
}
