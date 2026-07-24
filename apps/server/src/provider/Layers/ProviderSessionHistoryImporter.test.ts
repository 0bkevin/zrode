import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Message as OpenCodeMessage,
  OpencodeClient,
  Part as OpenCodePart,
  Session as OpenCodeSession,
} from "@opencode-ai/sdk/v2";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OpenCodeRuntime, OpenCodeRuntimeError } from "../opencodeRuntime.ts";
import {
  ProviderSessionHistoryImporter,
  ProviderSessionHistoryImportError,
} from "../Services/ProviderSessionHistoryImporter.ts";
import {
  ProviderSessionHistoryImporterLive,
  encodeClaudeProjectDirectoryName,
} from "./ProviderSessionHistoryImporter.ts";

const codexHistoryFixturePath = new URL(
  "../../../test/fixtures/codex-history-app-server-mock.ts",
  import.meta.url,
).pathname;

function orchestrationLayer(dispatched: OrchestrationCommand[]) {
  return Layer.succeed(OrchestrationEngineService, {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
    readEvents: (_fromSequenceExclusive: number) => Stream.empty,
    streamDomainEvents: Stream.empty as Stream.Stream<OrchestrationEvent>,
  });
}

const unusedOpenCodeRuntime = Layer.succeed(OpenCodeRuntime, {
  startOpenCodeServerProcess: () => Effect.die("unused"),
  connectToOpenCodeServer: () => Effect.die("unused"),
  runOpenCodeCommand: () => Effect.die("unused"),
  createOpenCodeSdkClient: () => {
    throw new Error("unused");
  },
  loadOpenCodeInventory: () => Effect.die("unused"),
});

it.layer(NodeServices.layer)("ProviderSessionHistoryImporter", (it) => {
  it.effect("encodes Claude project directories the way Claude Code does", () =>
    Effect.sync(() => {
      // Fixture verified against a real ~/.claude/projects directory: every
      // non-alphanumeric character (including "." and "_") becomes "-".
      expect(encodeClaudeProjectDirectoryName("/Users/me/.t3/worktrees/repo_a 1")).toBe(
        "-Users-me--t3-worktrees-repo-a-1",
      );
    }),
  );

  it.effect("imports complete top-level Codex sessions through the app-server protocol", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "zrode-codex-history-import-" });
      const workspaceRoot = path.join(root, "repo");
      yield* fs.makeDirectory(workspaceRoot, { recursive: true });
      const canonicalWorkspaceRoot = yield* fs.realPath(workspaceRoot);

      const spawnedCwds: Array<string | undefined> = [];
      const spawnedInstanceMarkers: Array<string | undefined> = [];
      const codexSpawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand") {
            return realSpawner.spawn(command);
          }
          spawnedCwds.push(command.options.cwd);
          spawnedInstanceMarkers.push(command.options.env?.CODEX_HISTORY_INSTANCE);
          return realSpawner.spawn(
            ChildProcess.make(process.execPath, [codexHistoryFixturePath], command.options),
          );
        }),
      );
      const dispatched: OrchestrationCommand[] = [];
      const layer = ProviderSessionHistoryImporterLive.pipe(
        Layer.provideMerge(orchestrationLayer(dispatched)),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              codex: {
                ...DEFAULT_SERVER_SETTINGS.providers.codex,
                enabled: false,
              },
              claudeAgent: {
                ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
                enabled: false,
              },
              opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: false },
            },
            providerInstances: {
              [ProviderInstanceId.make("codex")]: {
                driver: ProviderDriverKind.make("codex"),
                enabled: true,
                environment: [
                  {
                    name: "CODEX_HISTORY_INSTANCE",
                    value: "configured",
                    sensitive: false,
                  },
                ],
                config: {
                  binaryPath: "codex-history-test",
                  homePath: path.join(root, ".codex"),
                },
              },
            } as ServerSettings["providerInstances"],
          }),
        ),
        Layer.provideMerge(unusedOpenCodeRuntime),
        Layer.provideMerge(codexSpawnerLayer),
      );

      const importer = yield* Effect.service(ProviderSessionHistoryImporter).pipe(
        Effect.provide(layer),
      );
      yield* importer.importProjectHistory({
        projectId: ProjectId.make("project-codex"),
        workspaceRoot,
        providers: [ProviderDriverKind.make("codex")],
        requestedAt: "2026-01-01T00:00:02.000Z",
      });

      expect(spawnedCwds).toEqual([canonicalWorkspaceRoot]);
      expect(spawnedInstanceMarkers).toEqual(["configured"]);
      expect(dispatched).toHaveLength(1);
      const command = dispatched[0];
      expect(command?.type).toBe("thread.history.import");
      if (command?.type !== "thread.history.import") return;
      expect(command.provider).toBe(ProviderDriverKind.make("codex"));
      expect(command.providerThreadId).toBe("codex-main");
      expect(command.title).toBe("Imported Codex fixture");
      expect(command.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "User message from codex-main"],
        ["assistant", "Assistant message from codex-main"],
      ]);
    }),
  );

  it.effect("imports only the requested Claude project transcript", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "zrode-history-import-" });
      // The dotted segment exercises the non-alphanumeric directory encoding.
      const workspaceRoot = path.join(root, "repo.one");
      yield* fs.makeDirectory(workspaceRoot, { recursive: true });
      const canonicalWorkspaceRoot = yield* fs.realPath(workspaceRoot);
      const projectDirectory = path.join(
        root,
        ".claude",
        "projects",
        encodeClaudeProjectDirectoryName(canonicalWorkspaceRoot),
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
          `{"type":"user","session_id":"claude-session-1","isMeta":true,"timestamp":"2026-01-01T00:00:00.100Z","message":{"role":"user","content":"Caveat: injected meta notice"}}`,
          `{"type":"assistant","session_id":"claude-session-1","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"pondering"},{"type":"text","text":"Hi there"}]}}`,
          `{"type":"user","session_id":"claude-session-1","timestamp":"2026-01-01T00:00:01.200Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"raw tool output"}]}}`,
          `{"type":"user","session_id":"claude-session-1","isSidechain":true,"timestamp":"2026-01-01T00:00:01.400Z","message":{"role":"user","content":[{"type":"text","text":"subagent prompt"}]}}`,
          "not-json",
          `{"type":"user","session_id":"claude-session-1","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"user","content":[{"type":"text","text":"Too late"}]}}`,
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(unrelatedProjectDirectory, "session.jsonl"),
        `{"type":"user","session_id":"claude-other","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Wrong project"}]}}`,
      );

      const dispatched: OrchestrationCommand[] = [];
      const layer = ProviderSessionHistoryImporterLive.pipe(
        Layer.provideMerge(orchestrationLayer(dispatched)),
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
        Layer.provideMerge(unusedOpenCodeRuntime),
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

  it.effect(
    "reports Claude history permission failures instead of completing with no sessions",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "zrode-claude-history-failure-" });
        const workspaceRoot = path.join(root, "repo");
        yield* fs.makeDirectory(workspaceRoot, { recursive: true });
        const canonicalWorkspaceRoot = yield* fs.realPath(workspaceRoot);
        const projectDirectory = path.join(
          root,
          ".claude",
          "projects",
          encodeClaudeProjectDirectoryName(canonicalWorkspaceRoot),
        );
        const permissionError = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "readDirectory",
          pathOrDescriptor: projectDirectory,
        });
        let readAttempts = 0;
        const failingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          readDirectory: (directory, options) => {
            if (directory === projectDirectory) {
              readAttempts += 1;
              return Effect.fail(permissionError);
            }
            return fs.readDirectory(directory, options);
          },
        });
        const dispatched: OrchestrationCommand[] = [];
        const layer = ProviderSessionHistoryImporterLive.pipe(
          Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
          Layer.provideMerge(orchestrationLayer(dispatched)),
          Layer.provideMerge(
            ServerSettingsService.layerTest({
              providers: {
                codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
                claudeAgent: {
                  ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
                  enabled: true,
                  homePath: root,
                },
                opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: false },
              },
            }),
          ),
          Layer.provideMerge(unusedOpenCodeRuntime),
        );
        const importer = yield* Effect.service(ProviderSessionHistoryImporter).pipe(
          Effect.provide(layer),
        );

        const result = yield* Effect.exit(
          importer.importProjectHistory({
            projectId: ProjectId.make("project-claude-permission"),
            workspaceRoot,
            providers: [ProviderDriverKind.make("claudeAgent")],
            requestedAt: "2026-01-01T00:00:02.000Z",
          }),
        );

        expect(readAttempts).toBe(3);
        expect(dispatched).toHaveLength(0);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isSuccess(result)) return;
        const error = Cause.squash(result.cause);
        expect(error).toBeInstanceOf(ProviderSessionHistoryImportError);
        if (!(error instanceof ProviderSessionHistoryImportError)) return;
        expect(error.failures).toHaveLength(1);
        expect(error.failures[0]?.provider).toBe(ProviderDriverKind.make("claudeAgent"));
        expect(error.failures[0]?.detail).toContain("PermissionDenied");
      }),
  );

  it.effect("imports only complete top-level OpenCode project sessions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "zrode-opencode-history-import-" });
      const workspaceRoot = path.join(root, "repo");
      const beforeCutoff = Date.parse("2026-01-01T00:00:00.000Z");
      const afterCutoff = Date.parse("2026-01-01T00:00:03.000Z");
      yield* fs.makeDirectory(path.join(workspaceRoot, "src"), { recursive: true });
      const canonicalWorkspaceRoot = yield* fs.realPath(workspaceRoot);

      const session = (input: {
        readonly id: string;
        readonly directory: string;
        readonly created?: number;
        readonly parentID?: string;
      }): OpenCodeSession =>
        ({
          id: input.id,
          slug: input.id,
          projectID: "opencode-project",
          directory: input.directory,
          title: `Title ${input.id}`,
          version: "1.0.0",
          time: {
            created: input.created ?? beforeCutoff,
            updated: input.created ?? beforeCutoff + 1_000,
          },
          model: {
            providerID: "anthropic",
            id: "claude-sonnet",
          },
          ...(input.parentID ? { parentID: input.parentID } : {}),
        }) as OpenCodeSession;

      const sessions: OpenCodeSession[] = [
        session({ id: "opencode-main", directory: canonicalWorkspaceRoot }),
        session({
          id: "opencode-child",
          directory: canonicalWorkspaceRoot,
          parentID: "opencode-main",
        }),
        session({ id: "opencode-other", directory: path.join(root, "other") }),
        session({
          id: "opencode-after-cutoff",
          directory: canonicalWorkspaceRoot,
          created: afterCutoff,
        }),
      ];
      for (let index = sessions.length; index < 200; index += 1) {
        sessions.push(
          session({
            id: `opencode-unrelated-${index}`,
            directory: path.join(root, `other-${index}`),
          }),
        );
      }
      sessions.push(session({ id: "opencode-older-main", directory: canonicalWorkspaceRoot }));
      const userMessage = (id: string, created = beforeCutoff): OpenCodeMessage =>
        ({
          id,
          sessionID: "opencode-main",
          role: "user",
          time: { created },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet" },
        }) as OpenCodeMessage;
      const assistantMessage = (
        id: string,
        cwd: string,
        created = beforeCutoff + 1_000,
      ): OpenCodeMessage =>
        ({
          id,
          sessionID: "opencode-main",
          role: "assistant",
          time: { created, completed: created + 100 },
          parentID: "opencode-user",
          modelID: "claude-sonnet",
          providerID: "anthropic",
          mode: "build",
          agent: "build",
          path: { root: canonicalWorkspaceRoot, cwd },
          cost: 0,
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        }) as OpenCodeMessage;
      const textPart = (
        messageID: string,
        text: string,
        flags: { readonly ignored?: boolean; readonly synthetic?: boolean } = {},
      ): OpenCodePart =>
        ({
          id: `${messageID}-${text}`,
          sessionID: "opencode-main",
          messageID,
          type: "text",
          text,
          ...flags,
        }) as OpenCodePart;
      const messageRecords = [
        {
          info: userMessage("opencode-user"),
          parts: [
            textPart("opencode-user", "Hello OpenCode"),
            textPart("opencode-user", "Synthetic context", { synthetic: true }),
            textPart("opencode-user", "Ignored context", { ignored: true }),
          ],
        },
        {
          info: assistantMessage("opencode-assistant", path.join(canonicalWorkspaceRoot, "src")),
          parts: [textPart("opencode-assistant", "Hello from OpenCode")],
        },
        {
          info: assistantMessage("opencode-wrong-root", path.join(root, "other")),
          parts: [textPart("opencode-wrong-root", "Wrong workspace")],
        },
        {
          info: userMessage("opencode-too-late", afterCutoff),
          parts: [textPart("opencode-too-late", "Too late")],
        },
      ];
      const messageSessionIds: string[] = [];
      const sessionListInputs: Array<{
        readonly limit?: number;
        readonly roots?: boolean;
        readonly scope?: string;
        readonly start?: number;
      }> = [];
      const client = {
        session: {
          list: async (input: {
            readonly limit?: number;
            readonly roots?: boolean;
            readonly scope?: string;
            readonly start?: number;
          }) => {
            sessionListInputs.push(input);
            return { data: sessions.slice(0, input.limit) };
          },
          messages: async (input: { readonly sessionID: string }) => {
            messageSessionIds.push(input.sessionID);
            return {
              data:
                input.sessionID === "opencode-main" || input.sessionID === "opencode-older-main"
                  ? messageRecords
                  : [],
              response: new Response(),
            };
          },
        },
      } as unknown as OpencodeClient;
      const connectionInputs: Array<{
        readonly binaryPath: string;
        readonly serverUrl?: string | null;
        readonly environment?: NodeJS.ProcessEnv;
      }> = [];
      const runtimeLayer = Layer.succeed(OpenCodeRuntime, {
        startOpenCodeServerProcess: () => Effect.die("unused"),
        connectToOpenCodeServer: (input) => {
          connectionInputs.push(input);
          return Effect.succeed({
            url: "http://127.0.0.1:4096",
            exitCode: null,
            external: true,
          });
        },
        runOpenCodeCommand: () => Effect.die("unused"),
        createOpenCodeSdkClient: () => client,
        loadOpenCodeInventory: () => Effect.die("unused"),
      });
      const dispatched: OrchestrationCommand[] = [];
      const layer = ProviderSessionHistoryImporterLive.pipe(
        Layer.provideMerge(orchestrationLayer(dispatched)),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
              claudeAgent: {
                ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
                enabled: false,
              },
              opencode: {
                ...DEFAULT_SERVER_SETTINGS.providers.opencode,
                enabled: false,
              },
            },
            providerInstances: {
              [ProviderInstanceId.make("opencode")]: {
                driver: ProviderDriverKind.make("opencode"),
                enabled: true,
                environment: [
                  {
                    name: "OPENCODE_HISTORY_INSTANCE",
                    value: "configured",
                    sensitive: false,
                  },
                ],
                config: {
                  binaryPath: "opencode-history-test",
                  serverUrl: "http://127.0.0.1:4096",
                },
              },
            } as ServerSettings["providerInstances"],
          }),
        ),
        Layer.provideMerge(runtimeLayer),
      );

      const importer = yield* Effect.service(ProviderSessionHistoryImporter).pipe(
        Effect.provide(layer),
      );
      yield* importer.importProjectHistory({
        projectId: ProjectId.make("project-opencode"),
        workspaceRoot,
        providers: [ProviderDriverKind.make("opencode")],
        requestedAt: "2026-01-01T00:00:02.000Z",
      });

      expect(connectionInputs).toHaveLength(1);
      expect(connectionInputs[0]?.binaryPath).toBe("opencode-history-test");
      expect(connectionInputs[0]?.serverUrl).toBe("http://127.0.0.1:4096");
      expect(connectionInputs[0]?.environment?.OPENCODE_HISTORY_INSTANCE).toBe("configured");
      expect(sessionListInputs).toEqual([
        {
          directory: canonicalWorkspaceRoot,
          limit: Number.MAX_SAFE_INTEGER,
          roots: true,
          scope: "project",
        },
      ]);
      expect(messageSessionIds).toEqual([
        "opencode-main",
        "opencode-after-cutoff",
        "opencode-older-main",
      ]);
      expect(dispatched).toHaveLength(2);
      const command = dispatched.find(
        (candidate) =>
          candidate.type === "thread.history.import" &&
          candidate.providerThreadId === "opencode-main",
      );
      expect(command?.type).toBe("thread.history.import");
      if (command?.type !== "thread.history.import") return;
      expect(command.provider).toBe(ProviderDriverKind.make("opencode"));
      expect(command.providerThreadId).toBe("opencode-main");
      expect(command.modelSelection.model).toBe("anthropic/claude-sonnet");
      expect(command.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "Hello OpenCode"],
        ["assistant", "Hello from OpenCode"],
      ]);
      expect(
        dispatched.some(
          (candidate) =>
            candidate.type === "thread.history.import" &&
            candidate.providerThreadId === "opencode-older-main",
        ),
      ).toBe(true);
    }),
  );

  it.effect("uses OpenCode opaque cursors to import sessions with multiple message pages", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "zrode-opencode-message-pagination-",
      });
      const workspaceRoot = path.join(root, "repo");
      yield* fs.makeDirectory(workspaceRoot, { recursive: true });
      const canonicalWorkspaceRoot = yield* fs.realPath(workspaceRoot);
      const createdAt = Date.parse("2026-01-01T00:00:00.000Z");
      const records = Array.from({ length: 201 }, (_, index) => {
        const messageId = `opencode-message-${String(index).padStart(3, "0")}`;
        return {
          info: {
            id: messageId,
            sessionID: "opencode-paginated",
            role: "user",
            time: { created: createdAt + index },
            agent: "build",
            model: { providerID: "anthropic", modelID: "claude-sonnet" },
          } as OpenCodeMessage,
          parts: [
            {
              id: `${messageId}-part`,
              sessionID: "opencode-paginated",
              messageID: messageId,
              type: "text",
              text: `Message ${index}`,
            } as OpenCodePart,
          ],
        };
      });
      const messageRequests: Array<{ readonly before?: string; readonly limit?: number }> = [];
      const client = {
        session: {
          list: async () => ({
            data: [
              {
                id: "opencode-paginated",
                slug: "opencode-paginated",
                projectID: "opencode-project",
                directory: canonicalWorkspaceRoot,
                title: "Paginated OpenCode session",
                version: "1.0.0",
                time: { created: createdAt, updated: createdAt + 201 },
              } as OpenCodeSession,
            ],
          }),
          messages: async (input: { readonly before?: string; readonly limit?: number }) => {
            messageRequests.push(input);
            if (input.before === undefined) {
              return {
                data: records.slice(1),
                response: new Response(null, {
                  headers: { "X-Next-Cursor": "opaque-older-page" },
                }),
              };
            }
            if (input.before === "opaque-older-page") {
              return {
                data: records.slice(0, 1),
                response: new Response(),
              };
            }
            throw new Error(`Unexpected OpenCode cursor: ${input.before}`);
          },
        },
      } as unknown as OpencodeClient;
      const runtimeLayer = Layer.succeed(OpenCodeRuntime, {
        startOpenCodeServerProcess: () => Effect.die("unused"),
        connectToOpenCodeServer: () =>
          Effect.succeed({
            url: "http://127.0.0.1:4096",
            exitCode: null,
            external: true,
          }),
        runOpenCodeCommand: () => Effect.die("unused"),
        createOpenCodeSdkClient: () => client,
        loadOpenCodeInventory: () => Effect.die("unused"),
      });
      const dispatched: OrchestrationCommand[] = [];
      const layer = ProviderSessionHistoryImporterLive.pipe(
        Layer.provideMerge(orchestrationLayer(dispatched)),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
              claudeAgent: {
                ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
                enabled: false,
              },
              opencode: {
                ...DEFAULT_SERVER_SETTINGS.providers.opencode,
                enabled: true,
              },
            },
          }),
        ),
        Layer.provideMerge(runtimeLayer),
      );
      const importer = yield* Effect.service(ProviderSessionHistoryImporter).pipe(
        Effect.provide(layer),
      );

      yield* importer.importProjectHistory({
        projectId: ProjectId.make("project-opencode-pagination"),
        workspaceRoot,
        providers: [ProviderDriverKind.make("opencode")],
        requestedAt: "2026-01-01T00:01:00.000Z",
      });

      expect(messageRequests.map((request) => request.before)).toEqual([
        undefined,
        "opaque-older-page",
      ]);
      expect(messageRequests.every((request) => request.limit === 200)).toBe(true);
      expect(dispatched).toHaveLength(1);
      const command = dispatched[0];
      expect(command?.type).toBe("thread.history.import");
      if (command?.type !== "thread.history.import") return;
      expect(command.messages).toHaveLength(201);
      expect(command.messages[0]?.text).toBe("Message 0");
      expect(command.messages.at(-1)?.text).toBe("Message 200");
    }),
  );

  it.effect("retries failed providers, continues the others, and reports incomplete imports", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "zrode-history-retry-" });
      const workspaceRoot = path.join(root, "repo");
      yield* fs.makeDirectory(workspaceRoot, { recursive: true });
      const canonicalWorkspaceRoot = yield* fs.realPath(workspaceRoot);
      const projectDirectory = path.join(
        root,
        ".claude",
        "projects",
        encodeClaudeProjectDirectoryName(canonicalWorkspaceRoot),
      );
      yield* fs.makeDirectory(projectDirectory, { recursive: true });
      yield* fs.writeFileString(
        path.join(projectDirectory, "session.jsonl"),
        `{"type":"user","session_id":"claude-retry","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"Claude still imports"}}`,
      );

      let openCodeAttempts = 0;
      const runtimeLayer = Layer.succeed(OpenCodeRuntime, {
        startOpenCodeServerProcess: () => Effect.die("unused"),
        connectToOpenCodeServer: () => {
          openCodeAttempts += 1;
          return Effect.fail(
            new OpenCodeRuntimeError({
              operation: "connect",
              detail: "temporary failure",
            }),
          );
        },
        runOpenCodeCommand: () => Effect.die("unused"),
        createOpenCodeSdkClient: () => {
          throw new Error("unused");
        },
        loadOpenCodeInventory: () => Effect.die("unused"),
      });
      const dispatched: OrchestrationCommand[] = [];
      const projectId = ProjectId.make("project-retry");
      const layer = ProviderSessionHistoryImporterLive.pipe(
        Layer.provideMerge(orchestrationLayer(dispatched)),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
              claudeAgent: {
                ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
                enabled: true,
                homePath: root,
              },
              opencode: {
                ...DEFAULT_SERVER_SETTINGS.providers.opencode,
                enabled: true,
              },
            },
          }),
        ),
        Layer.provideMerge(runtimeLayer),
      );
      const importer = yield* Effect.service(ProviderSessionHistoryImporter).pipe(
        Effect.provide(layer),
      );

      const result = yield* Effect.exit(
        importer.importProjectHistory({
          projectId,
          workspaceRoot,
          providers: [ProviderDriverKind.make("opencode"), ProviderDriverKind.make("claudeAgent")],
          requestedAt: "2026-01-01T00:00:02.000Z",
        }),
      );

      expect(openCodeAttempts).toBe(3);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.type).toBe("thread.history.import");
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isSuccess(result)) return;
      const error = Cause.squash(result.cause);
      expect(error).toBeInstanceOf(ProviderSessionHistoryImportError);
      if (!(error instanceof ProviderSessionHistoryImportError)) return;
      expect(error.failures.map((failure) => failure.provider)).toEqual([
        ProviderDriverKind.make("opencode"),
      ]);
    }),
  );

  it.effect(
    "reports selected disabled and unsupported providers instead of silently skipping them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "zrode-history-unavailable-provider-",
        });
        const dispatched: OrchestrationCommand[] = [];
        const layer = ProviderSessionHistoryImporterLive.pipe(
          Layer.provideMerge(orchestrationLayer(dispatched)),
          Layer.provideMerge(
            ServerSettingsService.layerTest({
              providers: {
                codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
                claudeAgent: {
                  ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
                  enabled: false,
                },
                opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: false },
              },
            }),
          ),
          Layer.provideMerge(unusedOpenCodeRuntime),
        );
        const importer = yield* Effect.service(ProviderSessionHistoryImporter).pipe(
          Effect.provide(layer),
        );

        const result = yield* Effect.exit(
          importer.importProjectHistory({
            projectId: ProjectId.make("project-unavailable-provider"),
            workspaceRoot: path.resolve(workspaceRoot),
            providers: [ProviderDriverKind.make("codex"), ProviderDriverKind.make("cursor")],
            requestedAt: "2026-01-01T00:00:02.000Z",
          }),
        );

        expect(dispatched).toHaveLength(0);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isSuccess(result)) return;
        const error = Cause.squash(result.cause);
        expect(error).toBeInstanceOf(ProviderSessionHistoryImportError);
        if (!(error instanceof ProviderSessionHistoryImportError)) return;
        expect(error.failures.map((failure) => failure.provider)).toEqual([
          ProviderDriverKind.make("codex"),
          ProviderDriverKind.make("cursor"),
        ]);
        expect(error.failures[0]?.detail).toContain("disabled or has invalid settings");
        expect(error.failures[1]?.detail).toContain("not supported");
      }),
  );

  it.effect("retries persistence with stable ids instead of dropping an imported session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "zrode-history-dispatch-retry-" });
      const workspaceRoot = path.join(root, "repo");
      yield* fs.makeDirectory(workspaceRoot, { recursive: true });
      const canonicalWorkspaceRoot = yield* fs.realPath(workspaceRoot);
      const projectDirectory = path.join(
        root,
        ".claude",
        "projects",
        encodeClaudeProjectDirectoryName(canonicalWorkspaceRoot),
      );
      yield* fs.makeDirectory(projectDirectory, { recursive: true });
      yield* fs.writeFileString(
        path.join(projectDirectory, "session.jsonl"),
        `{"type":"user","session_id":"claude-dispatch-retry","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"Persist me"}}`,
      );

      const attemptedCommandIds: CommandId[] = [];
      const orchestration = Layer.succeed(OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) => {
          attemptedCommandIds.push(command.commandId);
          return attemptedCommandIds.length < 3
            ? Effect.die("temporary persistence failure")
            : Effect.succeed({ sequence: 1 });
        },
        readEvents: (_fromSequenceExclusive: number) => Stream.empty,
        streamDomainEvents: Stream.empty as Stream.Stream<OrchestrationEvent>,
      });
      const layer = ProviderSessionHistoryImporterLive.pipe(
        Layer.provideMerge(orchestration),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
              claudeAgent: {
                ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
                enabled: true,
                homePath: root,
              },
              opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: false },
            },
          }),
        ),
        Layer.provideMerge(unusedOpenCodeRuntime),
      );
      const importer = yield* Effect.service(ProviderSessionHistoryImporter).pipe(
        Effect.provide(layer),
      );

      yield* importer.importProjectHistory({
        projectId: ProjectId.make("project-dispatch-retry"),
        workspaceRoot,
        providers: [ProviderDriverKind.make("claudeAgent")],
        requestedAt: "2026-01-01T00:00:02.000Z",
      });

      expect(attemptedCommandIds).toHaveLength(3);
      expect(new Set(attemptedCommandIds).size).toBe(1);
    }),
  );
});
