import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
} from "@t3tools/contracts";

import { scopedThreadKey } from "../lib/scopedEntities";
import {
  clearOptimisticThreadDispatchState,
  hasAuthoritativeOptimisticDispatchOutcome,
  registerOptimisticThreadDispatchState,
  type OptimisticThreadDispatch,
} from "./thread-optimistic-dispatch";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const commandId = CommandId.make("command-1");
const messageId = MessageId.make("message-1");
const startedAt = "2026-07-22T10:00:00.000Z";

const readySession: OrchestrationSession = {
  threadId,
  status: "ready",
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-07-22T09:00:00.000Z",
};

const completedTurn: OrchestrationLatestTurn = {
  turnId: TurnId.make("turn-previous"),
  state: "completed",
  requestedAt: "2026-07-22T08:00:00.000Z",
  startedAt: "2026-07-22T08:00:01.000Z",
  completedAt: "2026-07-22T08:01:00.000Z",
  assistantMessageId: null,
};

function register(input?: {
  readonly thread?: {
    readonly latestTurn: OrchestrationLatestTurn | null;
    readonly session: OrchestrationSession | null;
  } | null;
}): OptimisticThreadDispatch {
  const state = registerOptimisticThreadDispatchState(
    {},
    {
      environmentId,
      threadId,
      commandId,
      messageId,
      startedAt,
      thread: input?.thread ?? {
        latestTurn: completedTurn,
        session: readySession,
      },
    },
  );
  const dispatch = state[scopedThreadKey(environmentId, threadId)];
  if (!dispatch) {
    throw new Error("Expected an optimistic dispatch.");
  }
  return dispatch;
}

describe("optimistic thread dispatch", () => {
  it("registers idle work immediately and keeps the first dispatch when a follow-up queues", () => {
    const initial = registerOptimisticThreadDispatchState(
      {},
      {
        environmentId,
        threadId,
        commandId,
        messageId,
        startedAt,
        thread: { latestTurn: completedTurn, session: readySession },
      },
    );
    const followUp = registerOptimisticThreadDispatchState(initial, {
      environmentId,
      threadId,
      commandId: CommandId.make("command-follow-up"),
      messageId: MessageId.make("message-follow-up"),
      startedAt: "2026-07-22T10:00:05.000Z",
      thread: { latestTurn: completedTurn, session: readySession },
    });

    expect(followUp).toBe(initial);
    expect(followUp[scopedThreadKey(environmentId, threadId)]).toMatchObject({
      commandId,
      messageId,
      startedAt,
    });
  });

  it("does not create active Working state for a follow-up on an authoritative busy thread", () => {
    const state = registerOptimisticThreadDispatchState(
      {},
      {
        environmentId,
        threadId,
        commandId,
        messageId,
        startedAt,
        thread: {
          latestTurn: {
            ...completedTurn,
            state: "running",
            completedAt: null,
          },
          session: {
            ...readySession,
            status: "running",
            activeTurnId: completedTurn.turnId,
          },
        },
      },
    );

    expect(state).toEqual({});
  });

  it("clears terminal local failures only when their stable ids match", () => {
    const state = registerOptimisticThreadDispatchState(
      {},
      {
        environmentId,
        threadId,
        commandId,
        messageId,
        startedAt,
        thread: { latestTurn: completedTurn, session: readySession },
      },
    );

    expect(
      clearOptimisticThreadDispatchState(state, {
        environmentId,
        threadId,
        messageId: MessageId.make("different-message"),
      }),
    ).toBe(state);
    expect(
      clearOptimisticThreadDispatchState(state, {
        environmentId,
        threadId,
        commandId,
        messageId,
      }),
    ).toEqual({});
  });

  it("hands new-thread Working state across navigation without clearing on ready projections", () => {
    const dispatch = register({ thread: null });

    expect(
      hasAuthoritativeOptimisticDispatchOutcome({
        dispatch,
        thread: {
          latestTurn: null,
          session: readySession,
        },
        activities: [],
      }),
    ).toBe(false);
    expect(
      hasAuthoritativeOptimisticDispatchOutcome({
        dispatch,
        thread: {
          latestTurn: {
            ...completedTurn,
            turnId: TurnId.make("turn-new"),
            state: "running",
            requestedAt: startedAt,
            startedAt: null,
            completedAt: null,
          },
          session: {
            ...readySession,
            status: "starting",
            updatedAt: "2026-07-22T10:00:01.000Z",
          },
        },
        activities: [],
      }),
    ).toBe(false);
  });

  it("clears only after a matching authoritative running turn has a start time", () => {
    const dispatch = register();
    const nextTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-next"),
      state: "running" as const,
      requestedAt: startedAt,
      startedAt: "2026-07-22T10:00:02.000Z",
      completedAt: null,
    };

    expect(
      hasAuthoritativeOptimisticDispatchOutcome({
        dispatch,
        thread: {
          latestTurn: nextTurn,
          session: {
            ...readySession,
            status: "running",
            activeTurnId: TurnId.make("turn-other"),
          },
        },
        activities: [],
      }),
    ).toBe(false);
    expect(
      hasAuthoritativeOptimisticDispatchOutcome({
        dispatch,
        thread: {
          latestTurn: nextTurn,
          session: {
            ...readySession,
            status: "running",
            activeTurnId: nextTurn.turnId,
          },
        },
        activities: [],
      }),
    ).toBe(true);
  });

  it("clears on a matching provider failure or changed terminal session error", () => {
    const dispatch = register();
    expect(
      hasAuthoritativeOptimisticDispatchOutcome({
        dispatch,
        thread: { latestTurn: completedTurn, session: readySession },
        activities: [
          {
            id: EventId.make("failure"),
            tone: "error",
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            payload: { messageId },
            turnId: null,
            createdAt: "2026-07-22T10:00:01.000Z",
          },
        ],
      }),
    ).toBe(true);

    expect(
      hasAuthoritativeOptimisticDispatchOutcome({
        dispatch,
        thread: {
          latestTurn: completedTurn,
          session: {
            ...readySession,
            status: "error",
            lastError: "Provider rejected turn/start",
            updatedAt: "2026-07-22T10:00:02.000Z",
          },
        },
        activities: [],
      }),
    ).toBe(true);
  });
});
