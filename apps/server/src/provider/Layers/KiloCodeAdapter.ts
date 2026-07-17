import {
  ApprovalRequestId,
  type KiloCodeSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { validateExpectedSteeringTurn } from "../Steering.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
  makeAcpUsageUpdatedEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyKiloCodeAcpModelSelection,
  availableKiloCodeModelsFromSessionSetup,
  currentKiloCodeModelIdFromSessionSetup,
  makeKiloCodeAcpRuntime,
  mergeKiloCodeSlashCommands,
  resolveKiloCodeAcpBaseModelId,
} from "../acp/KiloCodeAcpSupport.ts";
import { KILOCODE_SLASH_COMMANDS } from "./KiloCodeProvider.ts";
import { type KiloCodeAdapterShape } from "../Services/KiloCodeAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);

const PROVIDER = ProviderDriverKind.make("kilocode");
const KILOCODE_RESUME_VERSION = 1 as const;
const KILOCODE_START_TIMEOUT_MS = 30_000;
const KILOCODE_MODEL_SELECTION_TIMEOUT_MS = 15_000;
const KILOCODE_PROMPT_TIMEOUT_MS = 30 * 60_000;
const KILOCODE_CLOSE_TIMEOUT_MS = 2_000;
const KILOCODE_EVENT_DRAIN_TIMEOUT_MS = 1_000;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface KiloCodeAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly startTimeoutMs?: number;
  readonly modelSelectionTimeoutMs?: number;
  readonly promptTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly eventDrainTimeoutMs?: number;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface KiloCodeSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late prompt RPCs must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  promptsInFlight: number;
  currentModelId: string | undefined;
  readonly availableModels: ReadonlyArray<EffectAcpSchema.ModelInfo> | undefined;
  readonly modelConfigId: string | undefined;
  availableCommands: ReturnType<typeof mergeKiloCodeSlashCommands>;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function appendPromptResultToTurn(
  ctx: KiloCodeSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? { ...turn, items: [...turn.items, { prompt: promptParts, result }] }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseKiloCodeResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== KILOCODE_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

const resolveNotificationTurnId = (ctx: KiloCodeSessionContext): TurnId | undefined =>
  ctx.activeTurnId;

const resolveCallbackTurnId = (ctx: KiloCodeSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, KiloCodeSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => {
  const ctx = sessions.get(threadId);
  return ctx ? resolveCallbackTurnId(ctx) : undefined;
};

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

function completedStopReasonFromPromptResponse(
  response: EffectAcpSchema.PromptResponse | undefined,
): EffectAcpSchema.StopReason | null {
  return response?.stopReason ?? null;
}

export function KiloCodePromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly liveActiveTurnId: TurnId | undefined;
  readonly liveSessionActiveTurnId: TurnId | undefined;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  );
}

export function makeKiloCodeAdapter(
  kiloCodeSettings: KiloCodeSettings,
  options?: KiloCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("kilocode");
    const startTimeoutMs = options?.startTimeoutMs ?? KILOCODE_START_TIMEOUT_MS;
    const modelSelectionTimeoutMs =
      options?.modelSelectionTimeoutMs ?? KILOCODE_MODEL_SELECTION_TIMEOUT_MS;
    const promptTimeoutMs = options?.promptTimeoutMs ?? KILOCODE_PROMPT_TIMEOUT_MS;
    const closeTimeoutMs = options?.closeTimeoutMs ?? KILOCODE_CLOSE_TIMEOUT_MS;
    const eventDrainTimeoutMs = options?.eventDrainTimeoutMs ?? KILOCODE_EVENT_DRAIN_TIMEOUT_MS;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, KiloCodeSessionContext>();
    const deadlineScope = yield* Scope.make("parallel");
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate KiloCode runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process KiloCode ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const awaitUntilDeadline = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      timeoutMs: number,
    ): Effect.Effect<Option.Option<Exit.Exit<A, E>>, never, R> =>
      Effect.gen(function* () {
        // Detach the RPC fiber from the deadline waiter. Some ACP transport
        // calls are not promptly interruptible; making them a child would make
        // the winner wait for loser cleanup and defeat the deadline.
        const fiber = yield* effect.pipe(Effect.forkIn(deadlineScope, { startImmediately: true }));
        return yield* Effect.raceFirst(
          Fiber.await(fiber).pipe(Effect.map(Option.some)),
          Effect.sleep(timeoutMs).pipe(Effect.as(Option.none<Exit.Exit<A, E>>())),
        );
      });

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const settlePromptInFlight = (
      threadId: ThreadId,
      turnId: TurnId,
      expectedAcpSessionId: string,
      options?: {
        readonly errorMessage?: string;
        readonly completedStopReason?: EffectAcpSchema.StopReason | null;
        readonly emitTurnCompletion?: boolean;
        readonly settleAllPrompts?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(threadId);
        if (!liveCtx) return;
        const belongs = KiloCodePromptSettlementBelongsToContext({
          liveAcpSessionId: liveCtx.acpSessionId,
          expectedAcpSessionId,
          liveActiveTurnId: liveCtx.activeTurnId,
          liveSessionActiveTurnId: liveCtx.session.activeTurnId,
          turnId,
        });
        if (!belongs) {
          if (
            liveCtx.acpSessionId !== expectedAcpSessionId ||
            liveCtx.interruptedTurnIds.has(turnId)
          ) {
            return;
          }
          return;
        }

        if (options?.settleAllPrompts) {
          liveCtx.promptsInFlight = 0;
        } else {
          liveCtx.promptsInFlight = Math.max(0, liveCtx.promptsInFlight - 1);
          if (
            liveCtx.promptsInFlight > 0 ||
            liveCtx.activeTurnId !== turnId ||
            liveCtx.session.activeTurnId !== turnId
          ) {
            return;
          }
        }

        const canEmit =
          liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
        const updatedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
        liveCtx.activeTurnId = undefined;
        liveCtx.session = { ...readySession, status: "ready", updatedAt };

        if (options?.emitTurnCompletion === false || !canEmit) return;
        if (options?.errorMessage !== undefined) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId,
            payload: { state: "failed", errorMessage: options.errorMessage },
          });
        } else if (options?.completedStopReason !== undefined) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId,
            payload: {
              state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: options.completedStopReason,
            },
          });
        }
      });

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native KiloCode notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: KiloCodeSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<KiloCodeSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: KiloCodeSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        // Do not let an uninterruptible ACP RPC prevent session teardown or
        // replacement. Normal stop preserves provider-side resume state; it
        // terminates only this adapter process rather than closing the session.
        yield* ctx.acp.terminateProcess.pipe(Effect.ignore);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        if (sessions.get(ctx.threadId) === ctx) {
          sessions.delete(ctx.threadId);
        }
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const closeAndTerminateSession = (ctx: KiloCodeSessionContext) =>
      Effect.gen(function* () {
        const closeFiber = yield* ctx.acp.closeSession.pipe(
          Effect.forkIn(deadlineScope, { startImmediately: true }),
        );
        const closeOutcome = yield* Effect.raceFirst(
          Fiber.await(closeFiber).pipe(Effect.map(Option.some)),
          Effect.sleep(closeTimeoutMs).pipe(Effect.as(Option.none())),
        );
        const terminateResult = yield* ctx.acp.terminateProcess.pipe(Effect.result);

        if (Result.isFailure(terminateResult)) {
          return new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/terminate",
            detail: "Failed to terminate the Kilo Code ACP process after cancellation.",
            cause: terminateResult.failure,
          });
        }
        if (Option.isNone(closeOutcome)) {
          yield* Effect.logWarning(
            `Kilo Code session close timed out after ${closeTimeoutMs}ms; the ACP process was terminated instead.`,
          );
          return undefined;
        }
        if (Exit.isFailure(closeOutcome.value)) {
          yield* Effect.logWarning(
            "Kilo Code session close failed; the ACP process was terminated instead.",
          );
          return undefined;
        }
        return undefined;
      });

    const startSession: KiloCodeAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const kilocodeModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          // Kilo cancellation tears the whole ACP session down. Parallel
          // finalization ensures the child process is terminated even when an
          // in-flight RPC finalizer is waiting for a response that will never
          // arrive.
          const sessionScope = yield* Scope.make("parallel");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = parseKiloCodeResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeKiloCodeAcpRuntime({
            kiloCodeSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            resourceOwner: {
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
            },
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "zrode", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "zrode",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: resolveSessionCallbackTurnId(sessions, input.threadId),
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: sessions.get(input.threadId)?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            const started = yield* awaitUntilDeadline(acp.start(), startTimeoutMs);
            if (Option.isNone(started)) {
              yield* acp.terminateProcess.pipe(Effect.ignore);
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/start",
                detail: `Kilo Code ACP startup timed out after ${startTimeoutMs}ms.`,
              });
            }
            return yield* started.value;
          }).pipe(
            Effect.mapError((error) =>
              isProviderAdapterRequestError(error)
                ? error
                : mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const requestedStartModelId = kilocodeModelSelection?.model
            ? resolveKiloCodeAcpBaseModelId(kilocodeModelSelection.model)
            : undefined;
          const currentSetupModelId = currentKiloCodeModelIdFromSessionSetup(
            started.sessionSetupResult,
          );
          const availableSetupModels = availableKiloCodeModelsFromSessionSetup(
            started.sessionSetupResult,
          );
          const boundModelOutcome = yield* awaitUntilDeadline(
            applyKiloCodeAcpModelSelection({
              runtime: acp,
              currentModelId: currentSetupModelId,
              availableModels: availableSetupModels,
              requestedModelId: requestedStartModelId,
              modelConfigId: started.modelConfigId,
              mapError: ({ cause, step }) =>
                mapAcpToAdapterError(
                  PROVIDER,
                  input.threadId,
                  step === "set-session-model" ? "session/set_model" : "session/set_config_option",
                  cause,
                ),
              unsupportedModelError: (requestedModelId, supportedModelIds) =>
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "startSession",
                  issue: `Kilo Code model '${requestedModelId}' is not advertised by this session${supportedModelIds.length > 0 ? `; available models: ${supportedModelIds.join(", ")}` : ""}. Run provider discovery again and select an advertised provider/model identifier.`,
                }),
            }),
            modelSelectionTimeoutMs,
          );
          if (Option.isNone(boundModelOutcome)) {
            yield* acp.terminateProcess.pipe(Effect.ignore);
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/model-selection",
              detail: `Kilo Code model selection timed out after ${modelSelectionTimeoutMs}ms.`,
            });
          }
          const boundModelId = yield* boundModelOutcome.value;

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(boundModelId ? { model: boundModelId } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: KILOCODE_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: KiloCodeSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            currentModelId: boundModelId ?? currentSetupModelId,
            availableModels: availableSetupModels,
            modelConfigId: started.modelConfigId,
            availableCommands: mergeKiloCodeSlashCommands(
              KILOCODE_SLASH_COMMANDS,
              yield* acp.getAvailableCommands,
            ),
            stopped: false,
          };

          // Publish the context before the notification fiber starts so every
          // callback can verify it still belongs to the live ACP session.
          sessions.set(input.threadId, ctx);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                if (sessions.get(input.threadId) !== ctx || ctx.stopped) {
                  return;
                }
                if (
                  event._tag === "PlanUpdated" ||
                  event._tag === "ToolCallUpdated" ||
                  event._tag === "ContentDelta"
                ) {
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                }

                if (event._tag === "ModeChanged") {
                  return;
                }

                switch (event._tag) {
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: resolveNotificationTurnId(ctx),
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: resolveNotificationTurnId(ctx),
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload, "session/update");
                    return;
                  case "ToolCallUpdated":
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: resolveNotificationTurnId(ctx),
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: resolveNotificationTurnId(ctx),
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        streamKind: event.streamKind,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "UsageUpdated":
                    yield* offerRuntimeEvent(
                      makeAcpUsageUpdatedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: resolveNotificationTurnId(ctx),
                        usedTokens: event.usedTokens,
                        maxTokens: event.maxTokens,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "AvailableCommandsUpdated":
                    ctx.availableCommands = mergeKiloCodeSlashCommands(
                      KILOCODE_SLASH_COMMANDS,
                      event.commands,
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process KiloCode runtime notification.", { cause }),
            ),
            Effect.forkChild,
          );

          ctx.notificationFiber = nf;
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "KiloCode ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: KiloCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const initial = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            if (ctx.promptsInFlight > 0 && ctx.activeTurnId === undefined) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail:
                  "The interrupted Kilo Code prompt is still stopping; wait for it to settle before sending another prompt.",
              });
            }
            const steeringTurnId =
              input.expectedTurnId !== undefined
                ? ctx.activeTurnId
                : ctx.promptsInFlight > 0
                  ? ctx.activeTurnId
                  : undefined;
            yield* validateExpectedSteeringTurn({
              provider: PROVIDER,
              threadId: input.threadId,
              expectedTurnId: input.expectedTurnId,
              activeTurnId: steeringTurnId,
            });
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
            ctx.promptsInFlight += 1;
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: steeringTurnId === undefined ? "connecting" : "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };
            return { ctx, steeringTurnId, turnId } as const;
          }),
        );

        const ensurePreparationIsLive = Effect.suspend(() => {
          const liveCtx = sessions.get(input.threadId);
          if (
            liveCtx !== initial.ctx ||
            initial.ctx.stopped ||
            initial.ctx.interruptedTurnIds.has(initial.turnId)
          ) {
            return Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: "Kilo Code turn was cancelled during preparation.",
              }),
            );
          }
          return Effect.void;
        });

        const modelSelectionTimedOut = yield* Ref.make(false);
        const preparationExit = yield* Effect.gen(function* () {
          yield* ensurePreparationIsLive;
          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const requestedTurnModelId = turnModelSelection?.model
            ? resolveKiloCodeAcpBaseModelId(turnModelSelection.model)
            : undefined;
          const currentModelOutcome = yield* awaitUntilDeadline(
            applyKiloCodeAcpModelSelection({
              runtime: initial.ctx.acp,
              currentModelId: initial.ctx.currentModelId,
              availableModels: initial.ctx.availableModels,
              requestedModelId: requestedTurnModelId,
              modelConfigId: initial.ctx.modelConfigId,
              mapError: ({ cause, step }) =>
                mapAcpToAdapterError(
                  PROVIDER,
                  input.threadId,
                  step === "set-session-model" ? "session/set_model" : "session/set_config_option",
                  cause,
                ),
              unsupportedModelError: (requestedModelId, supportedModelIds) =>
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: `Kilo Code model '${requestedModelId}' is not advertised by this session${supportedModelIds.length > 0 ? `; available models: ${supportedModelIds.join(", ")}` : ""}. Select an advertised provider/model identifier.`,
                }),
            }),
            modelSelectionTimeoutMs,
          );
          if (Option.isNone(currentModelOutcome)) {
            yield* Ref.set(modelSelectionTimedOut, true);
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/model-selection",
              detail: `Kilo Code model selection timed out after ${modelSelectionTimeoutMs}ms.`,
            });
          }
          const currentModelId = yield* currentModelOutcome.value;
          yield* ensurePreparationIsLive;
          if (currentModelId) {
            initial.ctx.currentModelId = currentModelId;
          }

          const text = input.input?.trim();
          const imagePromptParts = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/prompt",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
              return {
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              } satisfies EffectAcpSchema.ContentBlock;
            }),
          );
          yield* ensurePreparationIsLive;
          const promptParts: Array<EffectAcpSchema.ContentBlock> = [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...imagePromptParts,
          ];

          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          return {
            displayModel: currentModelId ?? initial.ctx.currentModelId,
            promptParts,
          };
        }).pipe(Effect.exit);

        if (Exit.isFailure(preparationExit)) {
          const wasInterrupted =
            initial.ctx.stopped || initial.ctx.interruptedTurnIds.has(initial.turnId);
          if (wasInterrupted) {
            return {
              threadId: input.threadId,
              turnId: initial.turnId,
              resumeCursor: initial.ctx.session.resumeCursor,
            };
          }
          yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              yield* settlePromptInFlight(
                input.threadId,
                initial.turnId,
                initial.ctx.acpSessionId,
                { emitTurnCompletion: false },
              );
              if (
                (yield* Ref.get(modelSelectionTimedOut)) &&
                sessions.get(input.threadId) === initial.ctx
              ) {
                yield* closeAndTerminateSession(initial.ctx).pipe(Effect.ignore);
                yield* stopSessionInternal(initial.ctx);
              }
            }),
          );
          return yield* Effect.failCause(preparationExit.cause);
        }

        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            yield* ensurePreparationIsLive;
            if (initial.steeringTurnId === undefined) {
              initial.ctx.lastPlanFingerprint = undefined;
            }
            initial.ctx.session = {
              ...initial.ctx.session,
              status: "running",
              activeTurnId: initial.turnId,
              updatedAt: yield* nowIso,
              ...(preparationExit.value.displayModel
                ? { model: preparationExit.value.displayModel }
                : {}),
            };
            if (initial.steeringTurnId === undefined) {
              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: initial.turnId,
                payload: preparationExit.value.displayModel
                  ? { model: preparationExit.value.displayModel }
                  : {},
              });
            }
            return {
              acp: initial.ctx.acp,
              acpSessionId: initial.ctx.acpSessionId,
              displayModel: preparationExit.value.displayModel,
              promptParts: preparationExit.value.promptParts,
              turnId: initial.turnId,
            };
          }),
        );
        const promptSettled = yield* Ref.make(false);
        const promptTimedOut = yield* Ref.make(false);
        const promptWithDeadline = Effect.gen(function* () {
          const outcome = yield* awaitUntilDeadline(
            prepared.acp.prompt({ prompt: prepared.promptParts }),
            promptTimeoutMs,
          );
          if (Option.isNone(outcome)) {
            yield* Ref.set(promptTimedOut, true);
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: `Kilo Code prompt timed out after ${promptTimeoutMs}ms; prompts are never retried automatically.`,
            });
          }
          return yield* outcome.value;
        });
        const result = yield* promptWithDeadline.pipe(
          Effect.mapError((error) =>
            isProviderAdapterRequestError(error)
              ? error
              : error._tag === "AcpRequestError" && (error.code === -32000 || error.code === -32013)
                ? new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: `${error.message} Run \`kilo auth login\` in a terminal, then retry the turn.`,
                    cause: error,
                  })
                : mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.tapError((error) =>
            withThreadLock(
              input.threadId,
              Effect.gen(function* () {
                const liveCtx = sessions.get(input.threadId);
                if (liveCtx?.acpSessionId !== prepared.acpSessionId) return;
                yield* prepared.acp.drainEvents.pipe(
                  Effect.as(true),
                  Effect.timeoutOption(eventDrainTimeoutMs),
                  Effect.ignore,
                );
                yield* settlePromptInFlight(
                  input.threadId,
                  prepared.turnId,
                  prepared.acpSessionId,
                  { errorMessage: error.message },
                );
                if (yield* Ref.get(promptTimedOut)) {
                  yield* closeAndTerminateSession(liveCtx).pipe(Effect.ignore);
                  yield* stopSessionInternal(liveCtx);
                }
              }),
            ).pipe(Effect.andThen(Ref.set(promptSettled, true))),
          ),
        );

        return yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const liveCtx = sessions.get(input.threadId);
            if (!liveCtx || liveCtx.acpSessionId !== prepared.acpSessionId) {
              yield* Ref.set(promptSettled, true);
              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: liveCtx?.session.resumeCursor,
              };
            }
            yield* prepared.acp.drainEvents;
            if (liveCtx.interruptedTurnIds.has(prepared.turnId)) {
              liveCtx.promptsInFlight = Math.max(0, liveCtx.promptsInFlight - 1);
              if (liveCtx.promptsInFlight === 0) {
                liveCtx.interruptedTurnIds.delete(prepared.turnId);
              }
              yield* Ref.set(promptSettled, true);
              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: liveCtx.session.resumeCursor,
              };
            }
            appendPromptResultToTurn(liveCtx, prepared.turnId, prepared.promptParts, result);
            yield* settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
              completedStopReason: completedStopReasonFromPromptResponse(result),
            });
            yield* Ref.set(promptSettled, true);
            return {
              threadId: input.threadId,
              turnId: prepared.turnId,
              resumeCursor: liveCtx.session.resumeCursor,
            };
          }),
        ).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (yield* Ref.get(promptSettled)) return;
              yield* withThreadLock(
                input.threadId,
                settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                  errorMessage: "Kilo Code prompt ended before settlement.",
                }),
              ).pipe(Effect.ignore);
            }),
          ),
        );
      });

    const interruptTurn: KiloCodeAdapterShape["interruptTurn"] = (threadId, turnId) => {
      const observed = sessions.get(threadId);
      const observedTurnId = turnId ?? observed?.activeTurnId ?? observed?.session.activeTurnId;
      if (observed && observedTurnId) observed.interruptedTurnIds.add(observedTurnId);
      return withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return;
          }
          yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
          const interruptedTurnId = turnId ?? activeTurnId;
          if (!interruptedTurnId) {
            return;
          }
          ctx.interruptedTurnIds.add(interruptedTurnId);
          // Kilo explicitly does not support ACP session/cancel. session/close
          // is its supported abort path and best-effort aborts the underlying
          // SDK session. Bound the close request and always tear down the ACP
          // process so no late event can attach to a future turn.
          if (ctx.session.status === "running") {
            yield* ctx.acp.drainEvents.pipe(
              Effect.as(true),
              Effect.timeoutOption(eventDrainTimeoutMs),
              Effect.ignore,
            );
          }
          const closeError = yield* closeAndTerminateSession(ctx);
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: interruptedTurnId,
            payload: closeError
              ? {
                  state: "failed",
                  errorMessage: `Kilo Code cancellation could not be confirmed: ${closeError.message}`,
                }
              : { state: "cancelled", stopReason: "cancelled" },
          });
          yield* stopSessionInternal(ctx);
          if (closeError) {
            return yield* closeError;
          }
        }),
      );
    };

    const respondToRequest: KiloCodeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: KiloCodeAdapterShape["respondToUserInput"] = (
      threadId,
      _requestId,
      _answers,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/elicitation",
          detail: "Kilo Code ACP does not advertise elicitation support.",
        });
      });

    const readThread: KiloCodeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: KiloCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "KiloCode ACP sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: KiloCodeAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: KiloCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: KiloCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: KiloCodeAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => Scope.close(deadlineScope, Exit.void)),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies KiloCodeAdapterShape;
  });
}
