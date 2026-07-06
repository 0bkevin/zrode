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

import { ProviderSessionHistoryImporter } from "../../provider/Services/ProviderSessionHistoryImporter.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectSessionHistoryImportReactor } from "../Services/ProjectSessionHistoryImportReactor.ts";
import { ProjectSessionHistoryImportReactorLive } from "./ProjectSessionHistoryImportReactor.ts";

const now = "2026-01-01T00:00:00.000Z";

it.effect("replays persisted project session history import requests on start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const imported = yield* Ref.make<
        ReadonlyArray<{
          readonly projectId: ProjectId;
          readonly workspaceRoot: string;
          readonly providers: ReadonlyArray<ProviderDriverKind>;
          readonly requestedAt: string;
        }>
      >([]);
      const importerCalled = yield* Deferred.make<void>();
      const projectId = ProjectId.make("project-replay-import");
      const providers = [ProviderDriverKind.make("claudeAgent")];
      const replayedEvent: OrchestrationEvent = {
        sequence: 7,
        eventId: EventId.make("evt-project-import-replay"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.session-history-import-requested",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-import-replay"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-import-replay"),
        metadata: {},
        payload: {
          projectId,
          workspaceRoot: "/tmp/replay-project",
          providers,
          requestedAt: now,
        },
      };

      const layer = ProjectSessionHistoryImportReactorLive.pipe(
        Layer.provideMerge(
          Layer.succeed(OrchestrationEngineService, {
            readEvents: (fromSequenceExclusive: number) => {
              expect(fromSequenceExclusive).toBe(0);
              return Stream.fromIterable([replayedEvent]);
            },
            dispatch: (_command: OrchestrationCommand) =>
              Effect.die("dispatch should not be called by the import reactor"),
            streamDomainEvents: Stream.empty,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderSessionHistoryImporter, {
            importProjectHistory: (input) =>
              Ref.update(imported, (current) => [...current, input]).pipe(
                Effect.andThen(Deferred.succeed(importerCalled, undefined)),
              ),
          }),
        ),
      );

      const context = yield* Layer.build(layer);
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
    }),
  ),
);
