import {
  type GrokSettings,
  type ProviderInteractionMode,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { makeXAiPromptCompletionRuntime } from "./XAiAcpExtension.ts";

const GROK_API_KEY_ENV = "XAI_API_KEY";
const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const ZRODE_OAUTH_REFERRER = "zrode";
// Grok's ACP integration uses this private metadata to suppress interactive
// login. Without it, an unauthenticated background probe opens the browser.
const GROK_AUTHENTICATE_META = { headless: true } as const;
const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
const GROK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath">;

export interface GrokAcpLaunchOptions {
  readonly interactionMode?: ProviderInteractionMode;
  readonly reasoningEffort?: string;
  readonly runtimeMode?: RuntimeMode;
}

interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly launchOptions?: GrokAcpLaunchOptions;
}

export function resolveGrokPermissionMode(options: GrokAcpLaunchOptions | undefined): string {
  if (options?.interactionMode === "plan") return "plan";
  switch (options?.runtimeMode) {
    case "full-access":
      return "bypassPermissions";
    case "auto-accept-edits":
      return "acceptEdits";
    default:
      return "default";
  }
}

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeGrokSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  launchOptions?: GrokAcpLaunchOptions,
): AcpSessionRuntime.AcpSpawnInput {
  const reasoningEffort = launchOptions?.reasoningEffort?.trim();
  return {
    command: grokSettings?.binaryPath || "grok",
    args: [
      "--no-auto-update",
      "--permission-mode",
      resolveGrokPermissionMode(launchOptions),
      ...(reasoningEffort ? ["--effort", reasoningEffort] : []),
      "agent",
      "stdio",
    ],
    cwd,
    env: {
      ...environment,
      [GROK_OAUTH2_REFERRER_ENV]: ZRODE_OAUTH_REFERRER,
    },
  };
}

function resolveGrokAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[GROK_API_KEY_ENV]?.trim()
    ? GROK_AUTH_METHOD_API_KEY
    : GROK_AUTH_METHOD_CACHED_TOKEN;
}

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokAcpSpawnInput(
          input.grokSettings,
          input.cwd,
          input.environment,
          input.launchOptions,
        ),
        authMethodId: resolveGrokAuthMethodId(input.environment),
        authenticateMeta: GROK_AUTHENTICATE_META,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    return yield* makeXAiPromptCompletionRuntime(runtime);
  });

export function resolveGrokAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "grok-build";
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? "grok-build";
}

export function currentGrokModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
