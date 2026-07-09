// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type GitHubCopilotSettings, ProviderDriverKind } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import { expandHomePath } from "../../pathExpansion.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const GITHUB_COPILOT_AUTH_METHOD_ID = "copilot-login";
export const GITHUB_COPILOT_DEFAULT_MODEL = "auto";
export const GITHUB_COPILOT_MODEL_ENV = "COPILOT_MODEL";
export const GITHUB_COPILOT_HOME_ENV = "COPILOT_HOME";
export const GITHUB_COPILOT_DEFAULT_HOME_DIRECTORY = ".copilot";
export const GITHUB_COPILOT_TOKEN_ENV_PRECEDENCE = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
] as const;

const DRIVER_KIND = ProviderDriverKind.make("githubCopilot");

type GitHubCopilotAcpRuntimeSettings = Pick<GitHubCopilotSettings, "binaryPath" | "homePath">;

export interface GitHubCopilotAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  | "authMethodId"
  | "authenticateOnSessionAuthFailure"
  | "clientCapabilities"
  | "skipAuthenticate"
  | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly copilotSettings: GitHubCopilotAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly model?: string | null | undefined;
}

export function resolveGitHubCopilotAcpModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : GITHUB_COPILOT_DEFAULT_MODEL;
  return normalizeModelSlug(base, DRIVER_KIND) ?? GITHUB_COPILOT_DEFAULT_MODEL;
}

export function resolveGitHubCopilotHomePath(
  copilotSettings: GitHubCopilotAcpRuntimeSettings | null | undefined,
): string {
  const configuredHomePath = copilotSettings?.homePath?.trim();
  const homePath =
    configuredHomePath && configuredHomePath.length > 0
      ? expandHomePath(configuredHomePath)
      : NodePath.join(NodeOS.homedir(), GITHUB_COPILOT_DEFAULT_HOME_DIRECTORY);
  return NodePath.resolve(homePath);
}

export function makeGitHubCopilotContinuationGroupKey(
  copilotSettings: GitHubCopilotAcpRuntimeSettings | null | undefined,
): string {
  return `${DRIVER_KIND}:home:${resolveGitHubCopilotHomePath(copilotSettings)}`;
}

export function gitHubCopilotContinuationIdentity(
  copilotSettings: GitHubCopilotAcpRuntimeSettings | null | undefined,
) {
  return {
    driverKind: DRIVER_KIND,
    continuationKey: makeGitHubCopilotContinuationGroupKey(copilotSettings),
  };
}

export function resolveGitHubCopilotEnvironmentAuth(
  environment: NodeJS.ProcessEnv | undefined,
): { readonly status: "authenticated"; readonly type: "token"; readonly label: string } | null {
  for (const key of GITHUB_COPILOT_TOKEN_ENV_PRECEDENCE) {
    if (environment?.[key]?.trim()) {
      return {
        status: "authenticated",
        type: "token",
        label: key,
      };
    }
  }
  return null;
}

export function buildGitHubCopilotAcpEnvironment(input: {
  readonly copilotSettings: GitHubCopilotAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly model?: string | null | undefined;
}): NodeJS.ProcessEnv {
  const env = { ...input.environment };
  const homePath = input.copilotSettings?.homePath?.trim();
  if (homePath) {
    env[GITHUB_COPILOT_HOME_ENV] = resolveGitHubCopilotHomePath(input.copilotSettings);
  }
  const model = input.model ? resolveGitHubCopilotAcpModelId(input.model) : undefined;
  if (model) {
    env[GITHUB_COPILOT_MODEL_ENV] = model;
  }
  return env;
}

export function buildGitHubCopilotAcpSpawnInput(
  copilotSettings: GitHubCopilotAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  model?: string | null | undefined,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: copilotSettings?.binaryPath || "copilot",
    args: ["--acp", "--stdio"],
    cwd,
    env: buildGitHubCopilotAcpEnvironment({
      copilotSettings,
      environment,
      model,
    }),
  };
}

export function buildGitHubCopilotAcpRuntimeOptions(
  input: Omit<GitHubCopilotAcpRuntimeInput, "childProcessSpawner">,
): AcpSessionRuntime.AcpSessionRuntimeOptions {
  const { copilotSettings, environment, model, ...runtimeInput } = input;
  return {
    ...runtimeInput,
    spawn: buildGitHubCopilotAcpSpawnInput(copilotSettings, input.cwd, environment, model),
    /*
     * GitHub Copilot CLI's documented non-interactive auth surface is env
     * token based. `copilot-login` is the observed ACP method id, but we do
     * not proactively call it because cached `gh` / Copilot credentials may
     * already be valid and an auth call can prompt. The runtime only uses
     * this id as a fallback if session setup fails with auth-required and the
     * server advertises the exact method.
     */
    authMethodId: GITHUB_COPILOT_AUTH_METHOD_ID,
    skipAuthenticate: true,
    authenticateOnSessionAuthFailure: true,
  };
}

export const makeGitHubCopilotAcpRuntime = (
  input: GitHubCopilotAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer(buildGitHubCopilotAcpRuntimeOptions(input)).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });
