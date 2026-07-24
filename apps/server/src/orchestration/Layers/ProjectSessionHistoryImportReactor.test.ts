import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { expect, it } from "@effect/vitest";

import {
  ProviderSessionHistoryImporter,
  ProviderSessionHistoryImportError,
} from "../../provider/Services/ProviderSessionHistoryImporter.ts";
import type { ProviderSessionHistoryImportInput } from "../../provider/Services/ProviderSessionHistoryImporter.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectSessionHistoryImportReactor } from "../Services/ProjectSessionHistoryImportReactor.ts";
import { ProjectSessionHistoryImportReactorLive } from "./ProjectSessionHistoryImportReactor.ts";

const now = "2026-01-01T00:00:00.000Z";

function importRequestedEvent(input: {
  readonly sequence: number;
  readonly eventId: string;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly providers: ReadonlyArray<ProviderDriverKind>;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(input.eventId),
    aggregateKind: "project",
    aggregateId: input.projectId,
    type: "project.session-history-import-requested",
    occurredAt: now,
    commandId: CommandId.make(`cmd-${input.eventId}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-${input.eventId}`),
    metadata: {},
    payload: {
      projectId: input.projectId,
      workspaceRoot: input.workspaceRoot,
      providers: input.providers,
      requestedAt: now,
    },
  };
}

function importCompletedEvent(input: {
  readonly sequence: number;
  readonly eventId: string;
  readonly projectId: ProjectId;
  readonly requestEventId: string;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(input.eventId),
    aggregateKind: "project",
    aggregateId: input.projectId,
    type: "project.session-history-import-completed",
    occurredAt: now,
    commandId: CommandId.make(`cmd-${input.eventId}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-${input.eventId}`),
    metadata: {},
    payload: {
      projectId: input.projectId,
      requestEventId: EventId.make(input.requestEventId),
      completedAt: now,
    },
  };
}

function projectDeletedEvent(input: {
  readonly sequence: number;
  readonly eventId: string;
  readonly projectId: ProjectId;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(input.eventId),
    aggregateKind: "project",
    aggregateId: input.projectId,
    type: "project.deleted",
    occurredAt: now,
    commandId: CommandId.make(`cmd-${input.eventId}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-${input.eventId}`),
    metadata: {},
    payload: {
      projectId: input.projectId,
      deletedAt: now,
    },
  };
}

function makeHarnessLayer(input: {
  readonly persistedEvents: ReadonlyArray<OrchestrationEvent>;
  readonly liveEvents?: ReadonlyArray<OrchestrationEvent>;
  readonly imported: Ref.Ref<ReadonlyArray<ProviderSessionHistoryImportInput>>;
  readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly importerCalled: Deferred.Deferred<void>;
  readonly importerFailure?: ProviderSessionHistoryImportError;
}) {
  return ProjectSessionHistoryImportReactorLive.pipe(
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: (_fromSequenceExclusive: number) => Stream.fromIterable(input.persistedEvents),
        dispatch: (command: OrchestrationCommand) =>
          Ref.update(input.dispatched, (current) => [...current, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.fromIterable(
          input.liveEvents ?? [],
        ) as Stream.Stream<OrchestrationEvent>,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderSessionHistoryImporter, {
        importProjectHistory: (importInput) =>
          Ref.update(input.imported, (current) => [...current, importInput]).pipe(
            Effect.andThen(Deferred.succeed(input.importerCalled, undefined)),
            Effect.andThen(
              input.importerFailure === undefined
                ? Effect.void
                : Effect.fail(input.importerFailure),
            ),
          ),
      }),
    ),
  );
}

it.effect("replays pending import requests on start and records a completion event", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const imported = yield* Ref.make<ReadonlyArray<ProviderSessionHistoryImportInput>>([]);
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const importerCalled = yield* Deferred.make<void>();
      const projectId = ProjectId.make("project-replay-import");
      const providers = [ProviderDriverKind.make("claudeAgent")];
      const request = importRequestedEvent({
        sequence: 7,
        eventId: "evt-project-import-replay",
        projectId,
        workspaceRoot: "/tmp/replay-project",
        providers,
      });

      const context = yield* Layer.build(
        makeHarnessLayer({ persistedEvents: [request], imported, dispatched, importerCalled }),
      );
      const reactor = Context.get(context, ProjectSessionHistoryImportReactor);

      yield* reactor.start();
      yield* Deferred.await(importerCalled);
      yield* reactor.drain;

      expect(yield* Ref.get(imported)).toEqual([
        {
          projectId,
          workspaceRoot: "/tmp/replay-project",
          providers,
          requestedAt: now,
        },
      ]);

      const completions = yield* Ref.get(dispatched);
      expect(completions).toHaveLength(1);
      const completion = completions[0];
      expect(completion?.type).toBe("project.session-history-import.complete");
      if (completion?.type !== "project.session-history-import.complete") return;
      expect(completion.projectId).toBe(projectId);
      expect(completion.requestEventId).toBe(request.eventId);
      expect(completion.commandId).toBe(
        CommandId.make("history-import-complete-evt-project-import-replay"),
      );
    }),
  ),
);

it.effect("leaves a failed import pending instead of recording a false completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const imported = yield* Ref.make<ReadonlyArray<ProviderSessionHistoryImportInput>>([]);
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const importerCalled = yield* Deferred.make<void>();
      const projectId = ProjectId.make("project-failed-import");
      const provider = ProviderDriverKind.make("opencode");
      const request = importRequestedEvent({
        sequence: 7,
        eventId: "evt-project-import-failed",
        projectId,
        workspaceRoot: "/tmp/failed-project",
        providers: [provider],
      });

      const context = yield* Layer.build(
        makeHarnessLayer({
          persistedEvents: [request],
          imported,
          dispatched,
          importerCalled,
          importerFailure: new ProviderSessionHistoryImportError({
            projectId,
            failures: [{ provider, detail: "OpenCode was temporarily unavailable." }],
          }),
        }),
      );
      const reactor = Context.get(context, ProjectSessionHistoryImportReactor);

      yield* reactor.start();
      yield* Deferred.await(importerCalled);
      yield* reactor.drain;

      expect(yield* Ref.get(imported)).toHaveLength(1);
      expect(yield* Ref.get(dispatched)).toHaveLength(0);
    }),
  ),
);

it.effect("skips replayed import requests that already have a completion event", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const imported = yield* Ref.make<ReadonlyArray<ProviderSessionHistoryImportInput>>([]);
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const importerCalled = yield* Deferred.make<void>();
      const completedProjectId = ProjectId.make("project-completed");
      const pendingProjectId = ProjectId.make("project-pending");
      const providers = [ProviderDriverKind.make("claudeAgent")];
      const completedRequest = importRequestedEvent({
        sequence: 1,
        eventId: "evt-request-completed",
        projectId: completedProjectId,
        workspaceRoot: "/tmp/completed-project",
        providers,
      });
      const completion = importCompletedEvent({
        sequence: 2,
        eventId: "evt-completion",
        projectId: completedProjectId,
        requestEventId: "evt-request-completed",
      });
      const pendingRequest = importRequestedEvent({
        sequence: 3,
        eventId: "evt-request-pending",
        projectId: pendingProjectId,
        workspaceRoot: "/tmp/pending-project",
        providers,
      });

      const context = yield* Layer.build(
        makeHarnessLayer({
          persistedEvents: [completedRequest, completion, pendingRequest],
          imported,
          dispatched,
          importerCalled,
        }),
      );
      const reactor = Context.get(context, ProjectSessionHistoryImportReactor);

      yield* reactor.start();
      yield* Deferred.await(importerCalled);
      yield* reactor.drain;

      // The worker is sequential and requests replay in log order, so the
      // pending import having run proves the completed one was skipped.
      expect((yield* Ref.get(imported)).map((input) => input.projectId)).toEqual([
        pendingProjectId,
      ]);
    }),
  ),
);

it.effect("skips replayed import requests for deleted projects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const imported = yield* Ref.make<ReadonlyArray<ProviderSessionHistoryImportInput>>([]);
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const importerCalled = yield* Deferred.make<void>();
      const deletedProjectId = ProjectId.make("project-deleted");
      const pendingProjectId = ProjectId.make("project-pending");
      const providers = [ProviderDriverKind.make("claudeAgent")];
      const deletedRequest = importRequestedEvent({
        sequence: 1,
        eventId: "evt-request-deleted",
        projectId: deletedProjectId,
        workspaceRoot: "/tmp/deleted-project",
        providers,
      });
      const deletion = projectDeletedEvent({
        sequence: 2,
        eventId: "evt-project-deleted",
        projectId: deletedProjectId,
      });
      const pendingRequest = importRequestedEvent({
        sequence: 3,
        eventId: "evt-request-pending",
        projectId: pendingProjectId,
        workspaceRoot: "/tmp/pending-project",
        providers,
      });

      const context = yield* Layer.build(
        makeHarnessLayer({
          persistedEvents: [deletedRequest, deletion, pendingRequest],
          imported,
          dispatched,
          importerCalled,
        }),
      );
      const reactor = Context.get(context, ProjectSessionHistoryImportReactor);

      yield* reactor.start();
      yield* Deferred.await(importerCalled);
      yield* reactor.drain;

      expect((yield* Ref.get(imported)).map((input) => input.projectId)).toEqual([
        pendingProjectId,
      ]);
    }),
  ),
);

it.effect("processes a request delivered by both the replay and the live stream once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const imported = yield* Ref.make<ReadonlyArray<ProviderSessionHistoryImportInput>>([]);
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const importerCalled = yield* Deferred.make<void>();
      const projectId = ProjectId.make("project-duplicated-delivery");
      const providers = [ProviderDriverKind.make("claudeAgent")];
      const request = importRequestedEvent({
        sequence: 1,
        eventId: "evt-request-duplicated",
        projectId,
        workspaceRoot: "/tmp/duplicated-project",
        providers,
      });

      const context = yield* Layer.build(
        makeHarnessLayer({
          persistedEvents: [request],
          liveEvents: [request],
          imported,
          dispatched,
          importerCalled,
        }),
      );
      const reactor = Context.get(context, ProjectSessionHistoryImportReactor);

      yield* reactor.start();
      yield* Deferred.await(importerCalled);
      yield* reactor.drain;

      expect(yield* Ref.get(imported)).toHaveLength(1);
      expect(yield* Ref.get(dispatched)).toHaveLength(1);
    }),
  ),
);
