import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
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
      );

  const worker = yield* makeDrainableWorker(processEvent);

  const enqueueImportRequest = (event: OrchestrationEvent) => {
    if (event.type !== "project.session-history-import-requested") {
      return Effect.void;
    }
    return worker.enqueue(event);
  };

  const start: ProjectSessionHistoryImportReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, enqueueImportRequest),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.readEvents(0), enqueueImportRequest).pipe(
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
