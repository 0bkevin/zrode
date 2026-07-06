import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import { ProviderSessionHistoryImporter } from "../Services/ProviderSessionHistoryImporter.ts";
import { ProviderSessionHistoryImporterLive } from "./ProviderSessionHistoryImporter.ts";

function encodeClaudeProjectDirectoryName(workspaceRoot: string): string {
  return workspaceRoot.replace(/[\\/]/g, "-");
}

it.layer(NodeServices.layer)("ProviderSessionHistoryImporter", (it) => {
  it.effect("imports only the requested Claude project transcript", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "zrode-history-import-" });
      const workspaceRoot = path.join(root, "repo");
      const projectDirectory = path.join(
        root,
        ".claude",
        "projects",
        encodeClaudeProjectDirectoryName(path.resolve(workspaceRoot)),
      );
      const unrelatedProjectDirectory = path.join(
        root,
        ".claude",
        "projects",
        encodeClaudeProjectDirectoryName(path.join(root, "other")),
      );
      yield* fs.makeDirectory(projectDirectory, { recursive: true });
      yield* fs.makeDirectory(unrelatedProjectDirectory, { recursive: true });
      yield* fs.writeFileString(
        path.join(projectDirectory, "session.jsonl"),
        [
          `{"type":"user","session_id":"claude-session-1","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Hello Claude"}]}}`,
          `{"type":"assistant","session_id":"claude-session-1","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi there"}]}}`,
          `{"type":"user","session_id":"claude-session-1","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"user","content":[{"type":"text","text":"Too late"}]}}`,
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(unrelatedProjectDirectory, "session.jsonl"),
        `{"type":"user","session_id":"claude-other","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Wrong project"}]}}`,
      );

      const dispatched: OrchestrationCommand[] = [];
      const layer = ProviderSessionHistoryImporterLive.pipe(
        Layer.provideMerge(
          Layer.succeed(OrchestrationEngineService, {
            dispatch: (command: OrchestrationCommand) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: dispatched.length };
              }),
            readEvents: (_fromSequenceExclusive: number) => Stream.empty,
            streamDomainEvents: Stream.empty as Stream.Stream<OrchestrationEvent>,
          }),
        ),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              claudeAgent: {
                ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
                enabled: true,
                homePath: root,
              },
              codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
              opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: false },
            },
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(OpenCodeRuntime, {
            startOpenCodeServerProcess: () => Effect.die("unused"),
            connectToOpenCodeServer: () => Effect.die("unused"),
            runOpenCodeCommand: () => Effect.die("unused"),
            createOpenCodeSdkClient: () => {
              throw new Error("unused");
            },
            loadOpenCodeInventory: () => Effect.die("unused"),
          }),
        ),
      );

      const importer = yield* Effect.service(ProviderSessionHistoryImporter).pipe(
        Effect.provide(layer),
      );
      yield* importer.importProjectHistory({
        projectId: ProjectId.make("project-1"),
        workspaceRoot,
        providers: [ProviderDriverKind.make("claudeAgent")],
        requestedAt: "2026-01-01T00:00:02.000Z",
      });

      expect(dispatched).toHaveLength(1);
      const command = dispatched[0];
      expect(command?.type).toBe("thread.history.import");
      if (command?.type !== "thread.history.import") return;
      expect(command.commandId).toBe(CommandId.make(command.commandId));
      expect(command.provider).toBe(ProviderDriverKind.make("claudeAgent"));
      expect(command.providerThreadId).toBe("claude-session-1");
      expect(command.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "Hello Claude"],
        ["assistant", "Hi there"],
      ]);
    }),
  );
});
