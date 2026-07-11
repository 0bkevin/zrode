import {
  CommandId,
  type CheckpointRef,
  EventId,
  MessageId,
  type OrchestrationThread,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import { truncate } from "@t3tools/shared/String";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const DEFAULT_THREAD_TITLE = "New thread";

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function currentCheckpointTurnCount(thread: Pick<OrchestrationThread, "checkpoints">): number {
  return thread.checkpoints.reduce(
    (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
    0,
  );
}

function autoTitleCandidatesForMessageText(text: string): ReadonlySet<string> {
  const candidates = new Set<string>();
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    candidates.add(truncate(trimmed));
  }
  const withoutPromptEffortPrefix = trimmed.replace(/^Ultrathink:\s*/i, "").trim();
  if (withoutPromptEffortPrefix.length > 0) {
    candidates.add(truncate(withoutPromptEffortPrefix));
  }
  return candidates;
}

function isHistoryImportDomainEvent(event: OrchestrationEvent): boolean {
  return event.metadata.adapterKey?.startsWith("history-import:") ?? false;
}

function isTurnCompletionActivityEvent(
  event: OrchestrationEvent,
): event is Extract<OrchestrationEvent, { type: "thread.activity-appended" }> {
  return (
    event.type === "thread.activity-appended" &&
    event.payload.activity.kind === "turn.completed" &&
    event.payload.activity.turnId !== null
  );
}

function turnCompletionKey(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}): string {
  return `${input.threadId}\0${input.turnId}`;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-revert-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.revert.failed",
            summary: "Checkpoint revert failed",
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendEditFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly targetTurnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("message-edit-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "message.edit.failed",
            summary: "Message edit failed",
            payload: {
              messageId: input.messageId,
              targetTurnCount: input.targetTurnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-capture-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.capture.failed",
            summary: "Checkpoint capture failed",
            payload: {
              detail: input.detail,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  const isGitWorkspace = (cwd: string) => isGitRepository(cwd);

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!isGitWorkspace(cwd)) {
      return undefined;
    }
    return cwd;
  });

  // Shared tail for both capture paths: creates the git checkpoint ref, diffs
  // it against the previous turn, then dispatches the domain events to update
  // the orchestration read model.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // Refresh the workspace entry index so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.refresh(input.cwd);

    const files = yield* checkpointStore
      .diffCheckpoints({
        cwd: input.cwd,
        fromCheckpointRef,
        toCheckpointRef: targetCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      })
      .pipe(
        Effect.map((diff) =>
          parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
            path: file.path,
            kind: "modified" as const,
            additions: file.additions,
            deletions: file.deletions,
          })),
        ),
        Effect.tapError((error) =>
          appendCaptureFailureActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
            createdAt: input.createdAt,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to derive checkpoint file summary", {
            threadId: input.threadId,
            turnId: input.turnId,
            turnCount: input.turnCount,
            detail: error.message,
          }).pipe(Effect.as([])),
        ),
      );

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Captures a real git checkpoint when a turn completes via a runtime event.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly state?: string;
      readonly createdAt: string;
    }) {
      const turnId = event.turnId;
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = currentCheckpointTurnCount(thread);
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status: checkpointStatusFromRuntime(event.state),
        assistantMessageId: undefined,
        createdAt: event.createdAt,
      });
    },
  );

  const markTurnQuiesced = Effect.fn("markTurnQuiesced")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly createdAt: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.quiesce",
      commandId: CommandId.make(`server:turn-quiesce:${input.threadId}:${input.turnId}`),
      threadId: input.threadId,
      turnId: input.turnId,
      createdAt: input.createdAt,
    });
  });

  // Captures a real git checkpoint when a placeholder checkpoint (status "missing")
  // is detected via a domain event. This replaces the placeholder with a real
  // git-ref-based checkpoint.
  //
  // ProviderRuntimeIngestion creates placeholder checkpoints on turn.diff.updated
  // events from the Codex runtime. This handler fires when the corresponding
  // domain event arrives, allowing the reactor to capture the actual filesystem
  // state into a git ref and dispatch a replacement checkpoint.
  const captureCheckpointFromPlaceholder = Effect.fn("captureCheckpointFromPlaceholder")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) {
    const { threadId, turnId, checkpointTurnCount, status } = event.payload;

    // Only replace placeholders; skip events from our own real captures.
    if (status !== "missing") {
      return;
    }

    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      yield* Effect.logWarning("checkpoint capture from placeholder skipped: thread not found", {
        threadId,
      });
      return;
    }

    // If a real checkpoint already exists for this turn, skip.
    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      yield* Effect.logDebug(
        "checkpoint capture from placeholder skipped: real checkpoint already exists",
        { threadId, turnId },
      );
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) {
      return;
    }

    yield* captureAndDispatchCheckpoint({
      threadId,
      turnId,
      thread,
      cwd: checkpointCwd,
      turnCount: checkpointTurnCount,
      status: "ready",
      assistantMessageId: event.payload.assistantMessageId ?? undefined,
      createdAt: event.payload.completedAt,
    });
  });

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: false,
      });
      if (!checkpointCwd) {
        return;
      }

      const currentTurnCount = currentCheckpointTurnCount(thread);
      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      if (baselineExists) {
        return;
      }

      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: event.createdAt,
      });
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }),
      ),
    );
  });

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (isHistoryImportDomainEvent(event)) {
      return;
    }

    if (event.type === "thread.message-sent") {
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = currentCheckpointTurnCount(thread);
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  const restoreThreadToTurnCount = Effect.fn("restoreThreadToTurnCount")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly appendFailure: (detail: string) => Effect.Effect<unknown>;
  }) {
    const thread = yield* resolveThreadDetail(input.threadId);
    if (!thread) {
      yield* input.appendFailure("Thread was not found in read model.");
      return Option.none<{
        readonly thread: NonNullable<typeof thread>;
        readonly currentTurnCount: number;
      }>();
    }

    const sessionRuntime = yield* resolveSessionRuntimeForThread(input.threadId);
    if (Option.isNone(sessionRuntime)) {
      yield* input.appendFailure(
        "No active provider session with workspace cwd is bound to this thread.",
      );
      return Option.none<{
        readonly thread: typeof thread;
        readonly currentTurnCount: number;
      }>();
    }
    if (!isGitWorkspace(sessionRuntime.value.cwd)) {
      yield* input.appendFailure(
        "Checkpoints are unavailable because this project is not a git repository.",
      );
      return Option.none<{
        readonly thread: typeof thread;
        readonly currentTurnCount: number;
      }>();
    }

    const currentTurnCount = currentCheckpointTurnCount(thread);

    if (input.turnCount > currentTurnCount) {
      yield* input.appendFailure(
        `Checkpoint turn count ${input.turnCount} exceeds current turn count ${currentTurnCount}.`,
      );
      return Option.none<{
        readonly thread: typeof thread;
        readonly currentTurnCount: number;
      }>();
    }

    const targetCheckpointRef =
      input.turnCount === 0
        ? checkpointRefForThreadTurn(input.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === input.turnCount,
          )?.checkpointRef;

    if (!targetCheckpointRef) {
      yield* input.appendFailure(
        `Checkpoint ref for turn ${input.turnCount} is unavailable in read model.`,
      );
      return Option.none<{
        readonly thread: typeof thread;
        readonly currentTurnCount: number;
      }>();
    }

    const restored = yield* checkpointStore.restoreCheckpoint({
      cwd: sessionRuntime.value.cwd,
      checkpointRef: targetCheckpointRef,
      fallbackToHead: input.turnCount === 0,
    });
    if (!restored) {
      yield* input.appendFailure(
        `Filesystem checkpoint is unavailable for turn ${input.turnCount}.`,
      );
      return Option.none<{
        readonly thread: typeof thread;
        readonly currentTurnCount: number;
      }>();
    }

    // Refresh the workspace entry index so the @-mention file picker
    // reflects the reverted filesystem state.
    yield* workspaceEntries.refresh(sessionRuntime.value.cwd);

    const rolledBackTurns = Math.max(0, currentTurnCount - input.turnCount);
    if (rolledBackTurns > 0) {
      yield* providerService.rollbackConversation({
        threadId: sessionRuntime.value.threadId,
        numTurns: rolledBackTurns,
      });
    }

    const staleCheckpointRefs: Array<CheckpointRef> = [];
    for (const checkpoint of thread.checkpoints) {
      if (checkpoint.checkpointTurnCount > input.turnCount) {
        staleCheckpointRefs.push(checkpoint.checkpointRef);
      }
    }

    if (staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: sessionRuntime.value.cwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    return Option.some({ thread, currentTurnCount });
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);

    const restored = yield* restoreThreadToTurnCount({
      threadId: event.payload.threadId,
      turnCount: event.payload.turnCount,
      appendFailure: (detail) =>
        appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void)),
    });
    if (Option.isNone(restored)) {
      return;
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: yield* serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const resolveLastUserMessageEditStaleReason = Effect.fn("resolveLastUserMessageEditStaleReason")(
    function* (
      event: Extract<OrchestrationEvent, { type: "thread.last-user-message-edit-requested" }>,
    ) {
      const thread = yield* resolveThreadDetail(event.payload.threadId);
      if (!thread) {
        return "Thread was not found in read model.";
      }

      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return "Thread has an active turn.";
      }

      const liveCurrentTurnCount = currentCheckpointTurnCount(thread);
      if (liveCurrentTurnCount !== event.payload.expectedCurrentTurnCount) {
        return `Thread changed after the edit was requested; expected current turn count ${event.payload.expectedCurrentTurnCount} but found ${liveCurrentTurnCount}.`;
      }

      const messageIndex = thread.messages.findIndex(
        (message) => message.id === event.payload.messageId,
      );
      const message = messageIndex >= 0 ? thread.messages[messageIndex] : undefined;
      if (!message || message.role !== "user") {
        return `User message '${event.payload.messageId}' is no longer present.`;
      }

      const latestUserMessage = thread.messages.findLast((entry) => entry.role === "user");
      if (latestUserMessage?.id !== event.payload.messageId) {
        return "A newer user message exists.";
      }

      if ((message.attachments?.length ?? 0) > 0) {
        return `User message '${event.payload.messageId}' now has attachments.`;
      }

      const checkpoint = thread.checkpoints.find(
        (entry) =>
          entry.turnId === event.payload.checkpointTurnId &&
          entry.checkpointTurnCount === event.payload.checkpointTurnCount,
      );
      if (!checkpoint) {
        return "The checkpointed assistant turn is no longer available.";
      }

      const liveTargetTurnCount = Math.max(0, checkpoint.checkpointTurnCount - 1);
      if (liveTargetTurnCount !== event.payload.targetTurnCount) {
        return `Edit target turn count changed from ${event.payload.targetTurnCount} to ${liveTargetTurnCount}.`;
      }

      return null;
    },
  );

  const handleLastUserMessageEditRequested = Effect.fn("handleLastUserMessageEditRequested")(
    function* (
      event: Extract<OrchestrationEvent, { type: "thread.last-user-message-edit-requested" }>,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const staleReason = yield* resolveLastUserMessageEditStaleReason(event);
      if (staleReason !== null) {
        yield* appendEditFailureActivity({
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          targetTurnCount: event.payload.targetTurnCount,
          detail: staleReason,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      const restored = yield* restoreThreadToTurnCount({
        threadId: event.payload.threadId,
        turnCount: event.payload.targetTurnCount,
        appendFailure: (detail) =>
          appendEditFailureActivity({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            targetTurnCount: event.payload.targetTurnCount,
            detail,
            createdAt: now,
          }).pipe(Effect.catch(() => Effect.void)),
      });
      if (Option.isNone(restored)) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.revert.complete",
        commandId: yield* serverCommandId("message-edit-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.targetTurnCount,
        createdAt: now,
      });

      if (event.payload.targetTurnCount === 0 && event.payload.titleSeed !== undefined) {
        const previousMessage = restored.value.thread.messages.find(
          (message) => message.id === event.payload.messageId && message.role === "user",
        );
        const previousTitleCandidates = previousMessage
          ? autoTitleCandidatesForMessageText(previousMessage.text)
          : new Set<string>();
        const currentTitle = restored.value.thread.title.trim();
        const canReplaceTitle =
          currentTitle === DEFAULT_THREAD_TITLE || previousTitleCandidates.has(currentTitle);
        if (canReplaceTitle) {
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("message-edit-title-update"),
            threadId: event.payload.threadId,
            title: truncate(event.payload.titleSeed),
          });
        }
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: yield* serverCommandId("message-edit-turn-start"),
        threadId: event.payload.threadId,
        message: {
          messageId: event.payload.messageId,
          role: "user",
          text: event.payload.text,
          attachments: [],
        },
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
        runtimeMode: restored.value.thread.runtimeMode,
        interactionMode: restored.value.thread.interactionMode,
        createdAt: now,
      });
    },
  );

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }

    if (event.type === "thread.last-user-message-edit-requested") {
      yield* handleLastUserMessageEditRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendEditFailureActivity({
              threadId: event.payload.threadId,
              messageId: event.payload.messageId,
              targetTurnCount: event.payload.targetTurnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }

    // When ProviderRuntimeIngestion creates a placeholder checkpoint (status "missing")
    // from a turn.diff.updated runtime event, capture the real git checkpoint to
    // replace it. The providerService.streamEvents PubSub does not reliably deliver
    // turn.completed runtime events to this reactor (shared subscription), so
    // reacting to the domain event is the reliable path.
    if (event.type === "thread.turn-diff-completed") {
      yield* captureCheckpointFromPlaceholder(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }

    if (
      event.type === "thread.activity-appended" &&
      event.payload.activity.kind === "turn.completed" &&
      event.payload.activity.turnId !== null
    ) {
      const payload = event.payload.activity.payload;
      const state =
        typeof payload === "object" &&
        payload !== null &&
        "state" in payload &&
        typeof payload.state === "string"
          ? payload.state
          : undefined;
      const turnId = event.payload.activity.turnId;
      yield* captureCheckpointFromTurnCompletion({
        threadId: event.payload.threadId,
        turnId,
        ...(state !== undefined ? { state } : {}),
        createdAt: event.payload.activity.createdAt,
      }).pipe(
        Effect.catch((error) =>
          appendCaptureFailureActivity({
            threadId: event.payload.threadId,
            turnId,
            detail: error.message,
            createdAt: event.payload.activity.createdAt,
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
      yield* markTurnQuiesced({
        threadId: event.payload.threadId,
        turnId,
        createdAt: event.payload.activity.createdAt,
      });
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "turn.started") {
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed") {
      const turnId = toTurnId(event.turnId);
      yield* refreshLocalGitStatusFromTurnCompletion(event);
      yield* captureCheckpointFromTurnCompletion({
        threadId: event.threadId,
        turnId,
        state: event.payload.state,
        createdAt: event.createdAt,
      }).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<
    void,
    CheckpointStoreError | OrchestrationDispatchError | PlatformError.PlatformError,
    never
  > =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);
  const enqueuedTurnCompletionEventIds = new Set<string>();

  const enqueueTurnCompletionEvent = Effect.fn("enqueueTurnCompletionEvent")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.activity-appended" }>,
  ) {
    if (enqueuedTurnCompletionEventIds.has(event.eventId)) {
      return;
    }
    enqueuedTurnCompletionEventIds.add(event.eventId);
    yield* worker.enqueue({ source: "domain", event });
  });

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (isTurnCompletionActivityEvent(event)) {
          return enqueueTurnCompletionEvent(event);
        }
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested" &&
          event.type !== "thread.last-user-message-edit-requested" &&
          event.type !== "thread.turn-diff-completed"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    // Recover the narrow crash window where provider ingestion durably recorded
    // turn completion but checkpoint settlement had not yet emitted quiescence.
    // Completed pairs are discarded while scanning so normal startup does not
    // replay checkpoint work for the whole event history.
    const pendingTurnCompletions = new Map<
      string,
      Extract<OrchestrationEvent, { type: "thread.activity-appended" }>
    >();
    yield* Stream.runForEach(orchestrationEngine.readEvents(0), (event) =>
      Effect.sync(() => {
        if (isTurnCompletionActivityEvent(event)) {
          const turnId = event.payload.activity.turnId;
          if (turnId === null) {
            return;
          }
          pendingTurnCompletions.set(
            turnCompletionKey({
              threadId: event.payload.threadId,
              turnId,
            }),
            event,
          );
          return;
        }
        if (event.type === "thread.turn-quiesced") {
          pendingTurnCompletions.delete(
            turnCompletionKey({
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
            }),
          );
        }
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("checkpoint reactor failed to rebuild pending turn completions", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* Effect.forEach(pendingTurnCompletions.values(), enqueueTurnCompletionEvent, {
      concurrency: 1,
    }).pipe(Effect.asVoid);
    yield* worker.drain;

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.started" && event.type !== "turn.completed") {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
