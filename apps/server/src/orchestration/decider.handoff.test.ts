import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const NOW = "2026-01-01T00:00:00.000Z";

const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(NOW);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-handoff"),
    type: "project.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-handoff"),
      title: "Project Handoff",
      workspaceRoot: "/tmp/project-handoff",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  const withOtherProject = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-project-create-other"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-other"),
    type: "project.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-project-create-other"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create-other"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-other"),
      title: "Project Other",
      workspaceRoot: "/tmp/project-other",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  return yield* projectEvent(withOtherProject, {
    sequence: 3,
    eventId: asEventId("evt-thread-create-source"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-source"),
    type: "thread.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-thread-create-source"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-source"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-source"),
      projectId: asProjectId("project-handoff"),
      title: "Source Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
});

function handoffCreateCommand(
  overrides?: Partial<Extract<OrchestrationCommand, { type: "thread.create" }>>,
): Extract<OrchestrationCommand, { type: "thread.create" }> {
  return {
    type: "thread.create",
    commandId: asCommandId("cmd-handoff-create"),
    threadId: asThreadId("thread-target"),
    projectId: asProjectId("project-handoff"),
    title: "Handoff: Source Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
    handoffSource: {
      threadId: asThreadId("thread-source"),
      method: "transcript",
      createdAt: NOW,
    },
    createdAt: NOW,
    ...overrides,
  };
}

it.layer(NodeServices.layer)("decider thread.create handoff", (it) => {
  it.effect("emits thread.created plus a source-thread activity for a handoff", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const decided = yield* decideOrchestrationCommand({
        command: handoffCreateCommand(),
        readModel,
      });

      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(2);

      const created = events[0];
      expect(created?.type).toBe("thread.created");
      if (created?.type !== "thread.created") return;
      expect(created.aggregateId).toBe("thread-target");
      expect(created.payload.handoffSource).toEqual({
        threadId: "thread-source",
        method: "transcript",
        createdAt: NOW,
      });

      const activity = events[1];
      expect(activity?.type).toBe("thread.activity-appended");
      if (activity?.type !== "thread.activity-appended") return;
      expect(activity.aggregateId).toBe("thread-source");
      expect(activity.payload.threadId).toBe("thread-source");
      expect(activity.payload.activity.kind).toBe("handoff.target-created");
      expect(activity.payload.activity.tone).toBe("info");
      expect(activity.payload.activity.payload).toEqual({
        targetThreadId: "thread-target",
        method: "transcript",
      });
    }),
  );

  it.effect("emits a single event when no handoffSource is provided", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const command = handoffCreateCommand();
      const { handoffSource: _handoffSource, ...withoutHandoff } = command;
      const decided = yield* decideOrchestrationCommand({
        command: withoutHandoff,
        readModel,
      });

      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.created");
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.handoffSource).toBeUndefined();
      }
    }),
  );

  it.effect("rejects a handoff whose source thread does not exist", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: handoffCreateCommand({
          handoffSource: {
            threadId: asThreadId("thread-missing"),
            method: "summary",
            createdAt: NOW,
          },
        }),
        readModel,
      }).pipe(Effect.flip);

      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a handoff into a different project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: handoffCreateCommand({
          projectId: asProjectId("project-other"),
        }),
        readModel,
      }).pipe(Effect.flip);

      expect(result._tag).toBe("OrchestrationCommandInvariantError");
      if (result._tag === "OrchestrationCommandInvariantError") {
        expect(result.detail).toContain("belongs to project");
      }
    }),
  );

  it.effect("rejects a handoff whose source thread was deleted", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const withDeletedSource = yield* projectEvent(readModel, {
        sequence: 4,
        eventId: asEventId("evt-thread-delete-source"),
        aggregateKind: "thread",
        aggregateId: asThreadId("thread-source"),
        type: "thread.deleted",
        occurredAt: NOW,
        commandId: asCommandId("cmd-thread-delete-source"),
        causationEventId: null,
        correlationId: asCommandId("cmd-thread-delete-source"),
        metadata: {},
        payload: {
          threadId: asThreadId("thread-source"),
          deletedAt: NOW,
        },
      });

      const result = yield* decideOrchestrationCommand({
        command: handoffCreateCommand(),
        readModel: withDeletedSource,
      }).pipe(Effect.flip);

      expect(result._tag).toBe("OrchestrationCommandInvariantError");
      if (result._tag === "OrchestrationCommandInvariantError") {
        expect(result.detail).toContain("deleted");
      }
    }),
  );

  it.effect("projects handoffSource onto the created thread read model", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const decided = yield* decideOrchestrationCommand({
        command: handoffCreateCommand(),
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];

      let nextReadModel = readModel;
      let sequence = readModel.snapshotSequence;
      for (const event of events) {
        sequence += 1;
        nextReadModel = yield* projectEvent(nextReadModel, { ...event, sequence });
      }

      const target = nextReadModel.threads.find((thread) => thread.id === "thread-target");
      expect(target?.handoffSource).toEqual({
        threadId: "thread-source",
        method: "transcript",
        createdAt: NOW,
      });

      const source = nextReadModel.threads.find((thread) => thread.id === "thread-source");
      const handoffActivity = source?.activities.find(
        (activity) => activity.kind === "handoff.target-created",
      );
      expect(handoffActivity).toBeDefined();
      expect(handoffActivity?.payload).toEqual({
        targetThreadId: "thread-target",
        method: "transcript",
      });
    }),
  );
});
