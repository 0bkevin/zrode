import { CommandId, type OrchestrationCommand, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderSessionHistoryImporter } from "../../provider/Services/ProviderSessionHistoryImporter.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectSessionHistoryImportReactor,
  type ProjectSessionHistoryImportReactorShape,
} from "../Services/ProjectSessionHistoryImportReactor.ts";

type SessionHistoryImportRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "project.session-history-import-requested" }
>;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const importer = yield* ProviderSessionHistoryImporter;

  // Requests already enqueued during this run; guards against the startup
  // replay and the live subscription both delivering the same event.
  const enqueuedRequestEventIds = new Set<string>();

  const markImportCompleted = (event: SessionHistoryImportRequestedEvent) =>
    Effect.gen(function* () {
      const completedAt = DateTime.formatIso(yield* DateTime.now);
      const command: Extract<
        OrchestrationCommand,
        { type: "project.session-history-import.complete" }
      > = {
        type: "project.session-history-import.complete",
        commandId: CommandId.make(`history-import-complete-${event.eventId}`),
        projectId: event.payload.projectId,
        requestEventId: event.eventId,
        createdAt: completedAt,
      };
      yield* orchestrationEngine.dispatch(command);
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        // Left incomplete on purpose: the request is retried on next start.
        return Effect.logWarning("project session history import completion dispatch failed", {
          projectId: event.payload.projectId,
          requestEventId: event.eventId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const processEvent = (event: SessionHistoryImportRequestedEvent) =>
    importer
      .importProjectHistory({
        projectId: event.payload.projectId,
        workspaceRoot: event.payload.workspaceRoot,
        providers: event.payload.providers,
        requestedAt: event.payload.requestedAt,
      })
      .pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          return Effect.logWarning("project session history import reactor failed", {
            projectId: event.payload.projectId,
            providers: event.payload.providers,
            cause: Cause.pretty(cause),
          });
        }),
        // Completion is recorded even when the import failed so a persistent
        // failure does not re-run the scan on every server start. Interrupts
        // skip it, leaving the request pending for the next start.
        Effect.andThen(markImportCompleted(event)),
      );

  const worker = yield* makeDrainableWorker(processEvent);

  const enqueueImportRequest = (event: OrchestrationEvent) => {
    if (event.type !== "project.session-history-import-requested") {
      return Effect.void;
    }
    return Effect.suspend(() => {
      if (enqueuedRequestEventIds.has(event.eventId)) {
        return Effect.void;
      }
      enqueuedRequestEventIds.add(event.eventId);
      return worker.enqueue(event);
    });
  };

  // Reads the persisted log once and enqueues only requests that were never
  // marked completed and whose project still exists.
  const replayPendingImportRequests = Effect.gen(function* () {
    const requests = new Map<string, SessionHistoryImportRequestedEvent>();
    const completedRequestEventIds = new Set<string>();
    const deletedProjectIds = new Set<string>();
    yield* Stream.runForEach(
      orchestrationEngine.readEvents(0, [
        "project.session-history-import-requested",
        "project.session-history-import-completed",
        "project.deleted",
      ]),
      (event) =>
        Effect.sync(() => {
          if (event.type === "project.session-history-import-requested") {
            requests.set(event.eventId, event);
          } else if (event.type === "project.session-history-import-completed") {
            completedRequestEventIds.add(event.payload.requestEventId);
          } else if (event.type === "project.deleted") {
            deletedProjectIds.add(event.payload.projectId);
          }
        }),
    );
    for (const [eventId, event] of requests) {
      if (completedRequestEventIds.has(eventId)) continue;
      if (deletedProjectIds.has(event.payload.projectId)) continue;
      yield* enqueueImportRequest(event);
    }
  });

  const start: ProjectSessionHistoryImportReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, enqueueImportRequest),
    );
    yield* Effect.forkScoped(
      replayPendingImportRequests.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          return Effect.logWarning("project session history import replay failed", {
            cause: Cause.pretty(cause),
          });
        }),
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProjectSessionHistoryImportReactorShape;
});

export const ProjectSessionHistoryImportReactorLive = Layer.effect(
  ProjectSessionHistoryImportReactor,
  make,
);
