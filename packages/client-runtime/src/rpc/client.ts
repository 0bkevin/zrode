import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "./session.ts";

const IDEMPOTENT_REQUEST_RECONNECT_TIMEOUT = Duration.minutes(1);

export class EnvironmentRpcUnavailableError extends Schema.TaggedErrorClass<EnvironmentRpcUnavailableError>()(
  "EnvironmentRpcUnavailableError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export interface EnvironmentRpcRequestObservation {
  readonly environmentId: string;
  readonly method: string;
}

export class EnvironmentRpcRequestObserver extends Context.Reference<{
  readonly observe: (
    request: EnvironmentRpcRequestObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@t3tools/client-runtime/rpc/EnvironmentRpcRequestObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export type EnvironmentRpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends EnvironmentRpcTag> = WsRpcProtocolClient[TTag];

export type EnvironmentSubscriptionRpcTag =
  | typeof ORCHESTRATION_WS_METHODS.subscribeShell
  | typeof ORCHESTRATION_WS_METHODS.subscribeThread
  | typeof WS_METHODS.subscribeAuthAccess
  | typeof WS_METHODS.subscribeServerConfig
  | typeof WS_METHODS.subscribeServerLifecycle
  | typeof WS_METHODS.subscribeTerminalEvents
  | typeof WS_METHODS.subscribeTerminalMetadata
  | typeof WS_METHODS.subscribePreviewEvents
  | typeof WS_METHODS.subscribeDiscoveredLocalServers
  | typeof WS_METHODS.previewAutomationConnect
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof WS_METHODS.projectsWatchFiles
  | typeof WS_METHODS.terminalAttach;

export type EnvironmentStreamCommandRpcTag =
  | typeof WS_METHODS.cloudInstallRelayClient
  | typeof WS_METHODS.gitRunStackedAction
  | typeof WS_METHODS.projectsSearchText;

export type EnvironmentStreamRpcTag =
  | EnvironmentSubscriptionRpcTag
  | EnvironmentStreamCommandRpcTag;

export type EnvironmentUnaryRpcTag = Exclude<EnvironmentRpcTag, EnvironmentStreamRpcTag>;
const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

export type EnvironmentRpcInput<TTag extends EnvironmentRpcTag> = Parameters<RpcMethod<TTag>>[0];

export type EnvironmentRpcSuccess<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcFailure<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<any, infer E, any>
    ? E
    : never;

export type EnvironmentRpcStreamValue<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcStreamFailure<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<any, infer E, any>
    ? E
    : never;

const currentSession = Effect.fn("EnvironmentRpc.currentSession")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  return yield* SubscriptionRef.get(supervisor.session).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId: supervisor.target.environmentId,
              message: `${supervisor.target.label} is not connected.`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});

const invokeRequest = Effect.fn("EnvironmentRpc.invokeRequest")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(
  supervisor: EnvironmentSupervisor["Service"],
  session: RpcSession,
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
) {
  const observer = yield* EnvironmentRpcRequestObserver;
  const method = session.client[tag] as (
    input: EnvironmentRpcInput<TTag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<TTag>, EnvironmentRpcFailure<TTag>>;
  const completeObservation = yield* observer.observe({
    environmentId: supervisor.target.environmentId,
    method: tag,
  });
  return yield* method(input).pipe(Effect.ensuring(completeObservation));
});

const unavailableError = (
  supervisor: EnvironmentSupervisor["Service"],
  message = `${supervisor.target.label} is not connected.`,
) =>
  new EnvironmentRpcUnavailableError({
    environmentId: supervisor.target.environmentId,
    message,
  });

const awaitSessionAfter = Effect.fn("EnvironmentRpc.awaitSessionAfter")(function* (
  supervisor: EnvironmentSupervisor["Service"],
  previous: RpcSession | undefined,
) {
  const current = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isSome(current) && current.value !== previous) {
    return current.value;
  }
  const currentState = yield* SubscriptionRef.get(supervisor.state);
  if (currentState.phase === "blocked") {
    return yield* unavailableError(
      supervisor,
      currentState.lastFailure?.message ?? `${supervisor.target.label} connection is blocked.`,
    );
  }

  const nextSession = SubscriptionRef.changes(supervisor.session).pipe(
    Stream.filterMap((candidate) =>
      Option.isSome(candidate) && candidate.value !== previous
        ? Result.succeed(candidate.value)
        : Result.failVoid,
    ),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.interrupt,
        onSome: Effect.succeed,
      }),
    ),
  );
  const blocked = SubscriptionRef.changes(supervisor.state).pipe(
    Stream.filter((state) => state.phase === "blocked"),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.interrupt,
        onSome: (state) =>
          Effect.fail(
            unavailableError(
              supervisor,
              state.lastFailure?.message ?? `${supervisor.target.label} connection is blocked.`,
            ),
          ),
      }),
    ),
  );
  return yield* Effect.raceFirst(nextSession, blocked);
});

export const request = Effect.fn("EnvironmentRpc.request")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(tag: TTag, input: EnvironmentRpcInput<TTag>) {
  const supervisor = yield* EnvironmentSupervisor;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });
  const session = yield* currentSession();
  return yield* invokeRequest(supervisor, session, tag, input);
});

/**
 * Runs an idempotent unary request across transient connection loss.
 *
 * The same input is retried only after the supervisor installs a new session,
 * so callers must provide a server-side idempotency key. The wait is bounded
 * to keep permanent outages and blocked credentials visible to the user.
 */
export const requestIdempotent = Effect.fn("EnvironmentRpc.requestIdempotent")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(tag: TTag, input: EnvironmentRpcInput<TTag>) {
  const supervisor = yield* EnvironmentSupervisor;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });
  yield* supervisor.connect;

  const attempt = Effect.gen(function* () {
    let previous: RpcSession | undefined;
    for (;;) {
      const session = yield* awaitSessionAfter(supervisor, previous);
      const result = yield* Effect.result(invokeRequest(supervisor, session, tag, input));
      if (Result.isSuccess(result)) {
        return result.success;
      }
      if (!isRpcClientError(result.failure)) {
        return yield* Effect.fail(result.failure);
      }
      previous = session;
      yield* supervisor.retryNow;
    }
  });

  return yield* attempt.pipe(
    Effect.timeoutOrElse({
      duration: IDEMPOTENT_REQUEST_RECONNECT_TIMEOUT,
      orElse: () =>
        Effect.fail(
          unavailableError(
            supervisor,
            `${supervisor.target.label} did not reconnect in time to send the command.`,
          ),
        ),
    }),
  );
});

export function runStream<TTag extends EnvironmentStreamCommandRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag> | EnvironmentRpcUnavailableError,
  EnvironmentSupervisor
> {
  return Stream.unwrap(
    currentSession().pipe(
      Effect.map((session) => {
        const method = session.client[tag] as (
          input: EnvironmentRpcInput<TTag>,
        ) => Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>;
        return method(input);
      }),
    ),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.runStream", {
      attributes: { "rpc.method": tag },
    }),
  );
}

interface SubscriptionOptions<TTag extends EnvironmentSubscriptionRpcTag> {
  readonly onExpectedFailure?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly retryExpectedFailureAfter?: Duration.Input;
  readonly resubscribe?: Stream.Stream<unknown, never, never>;
}

export function subscribeDynamic<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return Stream.unwrap(
    EnvironmentSupervisor.pipe(
      Effect.map((supervisor) => {
        const sessionChanges = SubscriptionRef.changes(supervisor.session);
        const sessions =
          options?.resubscribe === undefined
            ? sessionChanges
            : Stream.merge(
                sessionChanges,
                options.resubscribe.pipe(
                  Stream.mapEffect(() => SubscriptionRef.get(supervisor.session)),
                ),
              );
        return sessions.pipe(
          Stream.switchMap(
            Option.match({
              onNone: () => Stream.empty,
              onSome: (session) => {
                const method = session.client[tag] as (
                  input: EnvironmentRpcInput<TTag>,
                ) => Stream.Stream<
                  EnvironmentRpcStreamValue<TTag>,
                  EnvironmentRpcStreamFailure<TTag>
                >;
                const subscribeToSession = (): Stream.Stream<
                  EnvironmentRpcStreamValue<TTag>,
                  EnvironmentRpcStreamFailure<TTag>
                > =>
                  Stream.suspend(() =>
                    Stream.unwrap(
                      makeInput(session).pipe(
                        Effect.map((input) =>
                          method(input).pipe(
                            Stream.catchCause((cause) => {
                              const hasOnlyExpectedFailures =
                                cause.reasons.length > 0 &&
                                cause.reasons.every((reason) => reason._tag === "Fail");
                              const isTransportFailure =
                                hasOnlyExpectedFailures &&
                                cause.reasons.every(
                                  (reason) =>
                                    reason._tag === "Fail" && isRpcClientError(reason.error),
                                );
                              if (isTransportFailure) {
                                return Stream.fromEffect(
                                  Effect.logWarning(
                                    "Durable RPC subscription lost its transport; waiting for the next session.",
                                    {
                                      cause: Cause.pretty(cause),
                                      method: tag,
                                      environmentId: supervisor.target.environmentId,
                                    },
                                  ),
                                ).pipe(Stream.drain);
                              }
                              if (
                                hasOnlyExpectedFailures &&
                                options?.onExpectedFailure !== undefined
                              ) {
                                const handled = Stream.fromEffect(
                                  options.onExpectedFailure(cause),
                                ).pipe(Stream.drain);
                                if (options.retryExpectedFailureAfter === undefined) {
                                  return handled;
                                }
                                return handled.pipe(
                                  Stream.concat(
                                    Stream.fromEffect(
                                      Effect.sleep(options.retryExpectedFailureAfter),
                                    ).pipe(Stream.drain),
                                  ),
                                  Stream.concat(subscribeToSession()),
                                );
                              }
                              return Stream.failCause(cause);
                            }),
                          ),
                        ),
                      ),
                    ),
                  );
                return subscribeToSession();
              },
            }),
          ),
        );
      }),
    ),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.subscribe", {
      attributes: { "rpc.method": tag },
    }),
  );
}

export function subscribe<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return subscribeDynamic(tag, () => Effect.succeed(input), options);
}

export const config = Effect.gen(function* () {
  const session = yield* currentSession();
  return yield* session.initialConfig;
}).pipe(Effect.withSpan("EnvironmentRpc.config"));
