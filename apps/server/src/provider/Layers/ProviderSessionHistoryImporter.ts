import * as NodeCrypto from "node:crypto";

import {
  CodexSettings,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  MessageId,
  OpenCodeSettings,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationMessageRole,
  type ProviderDriverKind as ProviderDriverKindType,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type { Message as OpenCodeMessage, OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  defaultClaudeInstanceSettings,
  resolveClaudeConfigDirPath,
} from "../Drivers/ClaudeHome.ts";
import { materializeCodexShadowHome, resolveCodexHomeLayout } from "../Drivers/CodexHomeLayout.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { OpenCodeRuntime, openCodeRuntimeErrorDetail, runOpenCodeSdk } from "../opencodeRuntime.ts";
import {
  ProviderSessionHistoryImporter,
  ProviderSessionHistoryImportError,
  type ProviderSessionHistoryImportInput,
  type ProviderSessionHistoryImporterShape,
} from "../Services/ProviderSessionHistoryImporter.ts";

const CODEX_PROVIDER = ProviderDriverKind.make("codex");
const CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");
const OPENCODE_PROVIDER = ProviderDriverKind.make("opencode");
const CURSOR_PROVIDER = ProviderDriverKind.make("cursor");
const DEVIN_PROVIDER = ProviderDriverKind.make("devin");
const GROK_PROVIDER = ProviderDriverKind.make("grok");
const KILOCODE_PROVIDER = ProviderDriverKind.make("kilocode");
const GITHUB_COPILOT_PROVIDER = ProviderDriverKind.make("githubCopilot");
const DEFAULT_CODEX_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_PROVIDER);
const DEFAULT_OPENCODE_INSTANCE_ID = defaultInstanceIdForDriver(OPENCODE_PROVIDER);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeOpenCodeSettings = Schema.decodeUnknownOption(OpenCodeSettings);

const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;
const MAX_IMPORTED_MESSAGES_PER_SESSION = 2_000;
const OPENCODE_PAGE_LIMIT = 200;
// OpenCode's session `start` parameter is a timestamp filter, not a pagination
// offset, and the endpoint does not expose a cursor. Request the complete
// project result set in one call so older sessions are not silently omitted.
const OPENCODE_SESSION_LIST_LIMIT = Number.MAX_SAFE_INTEGER;
const CODEX_PAGE_LIMIT = 100;
const PROVIDER_IMPORT_RETRY_COUNT = 2;
const CODEX_TOP_LEVEL_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "unknown",
] as const satisfies ReadonlyArray<CodexSchema.V2ThreadListParams__ThreadSourceKind>;

interface ImportedHistoryMessage {
  readonly role: OrchestrationMessageRole;
  readonly text: string;
  readonly createdAt: string;
}

interface ImportedHistorySession {
  readonly provider: ProviderDriverKindType;
  readonly providerThreadId: string;
  readonly title: string;
  readonly model?: string;
  readonly createdAt: string;
  readonly messages: ReadonlyArray<ImportedHistoryMessage>;
}

function defaultCodexInstanceSettings(settings: ServerSettings): {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
} {
  const instance = settings.providerInstances[DEFAULT_CODEX_INSTANCE_ID];
  if (instance === undefined) {
    return { config: settings.providers.codex, environment: process.env };
  }
  if (instance.driver !== CODEX_PROVIDER) {
    return {
      config: { ...settings.providers.codex, enabled: false },
      environment: process.env,
    };
  }
  const decoded = Option.getOrUndefined(decodeCodexSettings(instance.config ?? {}));
  if (decoded === undefined) {
    return {
      config: { ...settings.providers.codex, enabled: false },
      environment: process.env,
    };
  }
  return {
    config: { ...decoded, enabled: instance.enabled ?? decoded.enabled },
    environment: mergeProviderInstanceEnvironment(instance.environment),
  };
}

function defaultOpenCodeInstanceSettings(settings: ServerSettings): {
  readonly config: OpenCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
} {
  const instance = settings.providerInstances[DEFAULT_OPENCODE_INSTANCE_ID];
  if (instance === undefined) {
    return { config: settings.providers.opencode, environment: process.env };
  }
  if (instance.driver !== OPENCODE_PROVIDER) {
    return {
      config: { ...settings.providers.opencode, enabled: false },
      environment: process.env,
    };
  }
  const decoded = Option.getOrUndefined(decodeOpenCodeSettings(instance.config ?? {}));
  if (decoded === undefined) {
    return {
      config: { ...settings.providers.opencode, enabled: false },
      environment: process.env,
    };
  }
  return {
    config: { ...decoded, enabled: instance.enabled ?? decoded.enabled },
    environment: mergeProviderInstanceEnvironment(instance.environment),
  };
}

function stableHash(parts: ReadonlyArray<string>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 32);
}

function stableImportId(prefix: string, parts: ReadonlyArray<string>): string {
  return `${prefix}-${stableHash(parts)}`;
}

function truncateTitle(input: string, fallback: string): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return fallback;
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function previewTitle(messages: ReadonlyArray<ImportedHistoryMessage>, fallback: string): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
  return truncateTitle(firstUserMessage?.text ?? "", fallback);
}

function isoFromEpochSeconds(value: number | null | undefined, fallback: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return DateTime.formatIso(DateTime.makeUnsafe(value * 1000));
}

function isoFromEpochMillis(value: number | null | undefined, fallback: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return DateTime.formatIso(DateTime.makeUnsafe(value));
}

function epochMillisFromIso(value: string): number | null {
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? epochMs : null;
}

function isAtOrBeforeTimestamp(value: string, cutoff: string): boolean {
  const valueMs = epochMillisFromIso(value);
  const cutoffMs = epochMillisFromIso(cutoff);
  if (valueMs === null || cutoffMs === null) return false;
  return valueMs <= cutoffMs;
}

function filterSessionToConsentWindow(
  session: ImportedHistorySession,
  requestedAt: string,
): ImportedHistorySession | null {
  if (!isAtOrBeforeTimestamp(session.createdAt, requestedAt)) return null;
  const messages = session.messages.filter((message) =>
    isAtOrBeforeTimestamp(message.createdAt, requestedAt),
  );
  if (messages.length === 0) return null;
  return { ...session, messages };
}

function normalizePathValue(path: Path.Path, value: string): string {
  return path.resolve(value);
}

function isSameOrDescendantPath(path: Path.Path, value: string, root: string): boolean {
  const normalizedValue = normalizePathValue(path, value);
  const normalizedRoot = normalizePathValue(path, root);
  const relative = path.relative(normalizedRoot, normalizedValue);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function modelSelectionForProvider(
  provider: ProviderDriverKindType,
  preferredModel?: string,
): ModelSelection {
  return {
    instanceId: defaultInstanceIdForDriver(provider),
    model: preferredModel ?? DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL,
  };
}

function extractTextContent(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => extractTextContent(entry, depth + 1))
      .filter((entry) => entry.trim().length > 0)
      .join("\n");
  }
  if (typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  // Typed content blocks other than plain text (tool_use, tool_result,
  // thinking, image, ...) are not conversation prose and must not be
  // imported as user/assistant messages.
  if (typeof record.type === "string" && record.type !== "text") return "";
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content)) return extractTextContent(record.content, depth + 1);
  if (Array.isArray(record.text_elements))
    return extractTextContent(record.text_elements, depth + 1);
  return "";
}

function parseClaudeTranscriptMessage(
  line: string,
  expectedWorkspaceRoot: string,
  path: Path.Path,
): (ImportedHistoryMessage & { readonly sessionId?: string }) | null {
  let record: {
    readonly type?: unknown;
    readonly timestamp?: unknown;
    readonly session_id?: unknown;
    readonly sessionId?: unknown;
    readonly cwd?: unknown;
    readonly isSidechain?: unknown;
    readonly isMeta?: unknown;
    readonly message?: {
      readonly role?: unknown;
      readonly content?: unknown;
    } | null;
  };
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }

  // Sidechain lines belong to subagent conversations and meta lines are
  // injected notices; neither is part of the main conversation.
  if (record.isSidechain === true || record.isMeta === true) return null;

  const role =
    record.type === "user" || record.message?.role === "user"
      ? "user"
      : record.type === "assistant" || record.message?.role === "assistant"
        ? "assistant"
        : null;
  if (role === null) return null;

  if (
    typeof record.cwd === "string" &&
    !isSameOrDescendantPath(path, record.cwd, expectedWorkspaceRoot)
  ) {
    return null;
  }

  const text = extractTextContent(record.message?.content).trim();
  if (text.length === 0) return null;

  const epochMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  if (!Number.isFinite(epochMs)) return null;
  const createdAt = DateTime.formatIso(DateTime.makeUnsafe(epochMs));
  const rawSessionId =
    typeof record.session_id === "string"
      ? record.session_id
      : typeof record.sessionId === "string"
        ? record.sessionId
        : undefined;

  return {
    role,
    text,
    createdAt,
    ...(rawSessionId && rawSessionId.trim().length > 0 ? { sessionId: rawSessionId } : {}),
  };
}

// Claude Code stores each project's transcripts under a directory named after
// the workspace path with every non-alphanumeric character replaced by "-"
// (e.g. "/Users/me/.t3/repo" -> "-Users-me--t3-repo").
export function encodeClaudeProjectDirectoryName(workspaceRoot: string): string {
  return workspaceRoot.replace(/[^a-zA-Z0-9]/g, "-");
}

type CodexThread = CodexSchema.V2ThreadReadResponse["thread"];
type CodexThreadItem = CodexThread["turns"][number]["items"][number];

function textFromCodexUserMessage(item: Extract<CodexThreadItem, { type: "userMessage" }>): string {
  return item.content
    .map((content) => (content.type === "text" ? content.text : ""))
    .filter((text) => text.trim().length > 0)
    .join("\n");
}

function messagesFromCodexThread(
  thread: CodexThread,
  requestedAt: string,
): ReadonlyArray<ImportedHistoryMessage> {
  const messages: ImportedHistoryMessage[] = [];
  for (const turn of thread.turns) {
    const userCreatedAt = isoFromEpochSeconds(turn.startedAt ?? thread.createdAt, requestedAt);
    const assistantCreatedAt = isoFromEpochSeconds(
      turn.completedAt ?? turn.startedAt ?? thread.updatedAt,
      userCreatedAt,
    );
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const text = textFromCodexUserMessage(item).trim();
        if (text.length > 0) {
          messages.push({ role: "user", text, createdAt: userCreatedAt });
        }
      } else if (item.type === "agentMessage" || item.type === "plan") {
        const text = item.text.trim();
        if (text.length > 0) {
          messages.push({ role: "assistant", text, createdAt: assistantCreatedAt });
        }
      }
    }
  }
  return messages;
}

function textFromOpenCodePart(part: Part): string {
  if (part.type !== "text") return "";
  if (part.synthetic === true || part.ignored === true) return "";
  return part.text.trim();
}

function isOpenCodeMessageInProject(
  message: OpenCodeMessage,
  workspaceRoot: string,
  path: Path.Path,
): boolean {
  if (message.role !== "assistant") return true;
  return (
    normalizePathValue(path, message.path.root) === normalizePathValue(path, workspaceRoot) &&
    isSameOrDescendantPath(path, message.path.cwd, workspaceRoot)
  );
}

function importedMessageFromOpenCodeRecord(
  record: { readonly info: OpenCodeMessage; readonly parts: ReadonlyArray<Part> },
  requestedAt: string,
): ImportedHistoryMessage | null {
  const role = record.info.role;
  const text = record.parts.map(textFromOpenCodePart).filter(Boolean).join("\n").trim();
  if (text.length === 0) return null;
  return {
    role,
    text,
    createdAt: isoFromEpochMillis(
      role === "assistant"
        ? (record.info.time.completed ?? record.info.time.created)
        : record.info.time.created,
      requestedAt,
    ),
  };
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverSettings = yield* ServerSettingsService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const openCodeRuntime = yield* OpenCodeRuntime;

  const dispatchImportedSession = (
    input: ProviderSessionHistoryImportInput,
    session: ImportedHistorySession,
  ) =>
    Effect.gen(function* () {
      // Keep the newest messages when capping, matching the projector's
      // thread cap policy — recent context is the useful part.
      const messages = session.messages.slice(-MAX_IMPORTED_MESSAGES_PER_SESSION);
      if (messages.length === 0) return;
      if (session.messages.length > messages.length) {
        yield* Effect.logWarning("provider session history import truncated messages", {
          projectId: input.projectId,
          provider: session.provider,
          providerThreadId: session.providerThreadId,
          importedMessages: messages.length,
          skippedMessages: session.messages.length - messages.length,
        });
      }

      const idParts = [
        input.projectId,
        input.workspaceRoot,
        session.provider,
        session.providerThreadId,
      ];
      const threadId = ThreadId.make(stableImportId("history-thread", idParts));
      const command: Extract<OrchestrationCommand, { type: "thread.history.import" }> = {
        type: "thread.history.import",
        commandId: CommandId.make(stableImportId("history-import", idParts)),
        threadId,
        projectId: ProjectId.make(input.projectId),
        title: truncateTitle(
          session.title,
          previewTitle(messages, `Imported ${session.provider} session`),
        ),
        modelSelection: modelSelectionForProvider(session.provider, session.model),
        provider: session.provider,
        providerThreadId: session.providerThreadId,
        messages: messages.map((message, index) => ({
          messageId: MessageId.make(
            stableImportId("history-message", [
              ...idParts,
              String(index),
              message.role,
              message.createdAt,
            ]),
          ),
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        })),
        createdAt: session.createdAt,
      };

      yield* orchestrationEngine.dispatch(command);
    });

  const importCodexHistory = (input: ProviderSessionHistoryImportInput, settings: ServerSettings) =>
    Effect.scoped(
      Effect.gen(function* () {
        const codex = defaultCodexInstanceSettings(settings);
        if (!codex.config.enabled) return [];
        const layout = yield* resolveCodexHomeLayout(codex.config);
        if (layout.mode === "authOverlay") {
          yield* materializeCodexShadowHome(layout);
        }

        const homePath = layout.effectiveHomePath ?? layout.sharedHomePath;
        const env = {
          ...codex.environment,
          CODEX_HOME: expandHomePath(homePath),
        };
        const spawnCommand = yield* resolveSpawnCommand(codex.config.binaryPath, ["app-server"], {
          env,
          extendEnv: true,
        });
        const child = yield* spawner
          .spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              cwd: input.workspaceRoot,
              env,
              extendEnv: true,
              forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
              shell: spawnCommand.shell,
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new CodexErrors.CodexAppServerSpawnError({
                  command: `${codex.config.binaryPath} app-server`,
                  cause,
                }),
            ),
          );
        const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
        const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(clientContext),
        );

        yield* client.request("initialize", buildCodexInitializeParams());
        yield* client.notify("initialized", undefined);

        const listed = new Map<string, CodexSchema.V2ThreadListResponse["data"][number]>();
        for (const archived of [false, true]) {
          let cursor: string | null | undefined = undefined;
          for (;;) {
            const response: CodexSchema.V2ThreadListResponse = yield* client.request(
              "thread/list",
              {
                cwd: input.workspaceRoot,
                archived,
                cursor: cursor ?? null,
                limit: CODEX_PAGE_LIMIT,
                sortKey: "created_at",
                sortDirection: "asc",
                sourceKinds: CODEX_TOP_LEVEL_SOURCE_KINDS,
              },
            );
            for (const thread of response.data) {
              if (
                thread.parentThreadId == null &&
                normalizePathValue(path, thread.cwd) ===
                  normalizePathValue(path, input.workspaceRoot)
              ) {
                listed.set(thread.id, thread);
              }
            }
            // Guard against a server that keeps returning the same cursor or
            // a cursor alongside an empty page — this loop must terminate.
            const nextCursor = response.nextCursor;
            if (
              nextCursor === null ||
              nextCursor === undefined ||
              nextCursor === cursor ||
              response.data.length === 0
            ) {
              break;
            }
            cursor = nextCursor;
          }
        }

        const imported: ReadonlyArray<ImportedHistorySession> = yield* Effect.forEach(
          [...listed.values()],
          (listedThread) =>
            client.request("thread/read", { threadId: listedThread.id, includeTurns: true }).pipe(
              Effect.map(({ thread }) => {
                const messages = messagesFromCodexThread(thread, input.requestedAt);
                return {
                  provider: CODEX_PROVIDER,
                  providerThreadId: thread.id,
                  title: truncateTitle(
                    thread.name ?? thread.preview ?? "",
                    previewTitle(messages, "Imported Codex session"),
                  ),
                  createdAt: isoFromEpochSeconds(thread.createdAt, input.requestedAt),
                  messages,
                } satisfies ImportedHistorySession;
              }),
            ),
          { concurrency: 2 },
        );

        return imported.filter((session) => session.messages.length > 0);
      }),
    );

  const importClaudeHistory = (
    input: ProviderSessionHistoryImportInput,
    settings: ServerSettings,
  ) =>
    Effect.gen(function* () {
      const claude = defaultClaudeInstanceSettings(settings);
      if (!claude.config.enabled) return [];
      const claudeConfigDir = yield* resolveClaudeConfigDirPath(claude.config, claude.environment);
      const normalizedWorkspaceRoot = normalizePathValue(path, input.workspaceRoot);
      const projectDirectoryName = encodeClaudeProjectDirectoryName(normalizedWorkspaceRoot);
      const projectDirectory = path.join(claudeConfigDir, "projects", projectDirectoryName);
      const entries = yield* fs
        .readDirectory(projectDirectory, { recursive: true })
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed([] as ReadonlyArray<string>)
              : Effect.fail(error),
          ),
        );
      const files = entries
        .filter((entry) => entry.endsWith(".jsonl"))
        .map((entry) => path.join(projectDirectory, entry))
        .toSorted();

      const messagesBySession = new Map<string, ImportedHistoryMessage[]>();
      yield* Effect.forEach(
        files,
        (filePath) =>
          Effect.gen(function* () {
            const fallbackSessionId = path.basename(filePath).replace(/\.jsonl$/i, "");
            yield* fs.stream(filePath).pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) =>
                Effect.sync(() => {
                  const message = parseClaudeTranscriptMessage(line, normalizedWorkspaceRoot, path);
                  if (message === null) return;
                  const sessionId = message.sessionId ?? fallbackSessionId;
                  const existing = messagesBySession.get(sessionId);
                  const bucket = existing ?? [];
                  if (existing === undefined) {
                    messagesBySession.set(sessionId, bucket);
                  }
                  bucket.push({
                    role: message.role,
                    text: message.text,
                    createdAt: message.createdAt,
                  });
                }),
              ),
            );
          }),
        // Sequential so messages sharing a session id across files accumulate
        // in a deterministic order before the stable timestamp sort.
        { concurrency: 1, discard: true },
      );

      const imported: ReadonlyArray<ImportedHistorySession> = [...messagesBySession.entries()]
        .map(([sessionId, messages]) => {
          // toSorted is stable, so same-timestamp messages keep file order.
          const sortedMessages = messages.toSorted((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
          );
          return {
            provider: CLAUDE_PROVIDER,
            providerThreadId: sessionId,
            title: previewTitle(sortedMessages, "Imported Claude session"),
            createdAt: sortedMessages[0]?.createdAt ?? input.requestedAt,
            messages: sortedMessages,
          } satisfies ImportedHistorySession;
        })
        .filter((session) => session.messages.length > 0);
      return imported;
    });

  const listOpenCodeSessions = (client: OpencodeClient, workspaceRoot: string) =>
    Effect.gen(function* () {
      const response = yield* runOpenCodeSdk("session.list", () =>
        client.session.list({
          directory: workspaceRoot,
          scope: "project",
          roots: true,
          limit: OPENCODE_SESSION_LIST_LIMIT,
        }),
      );
      return response.data ?? [];
    });

  const listOpenCodeMessages = (client: OpencodeClient, workspaceRoot: string, sessionId: string) =>
    Effect.gen(function* () {
      const records: Array<{
        readonly info: OpenCodeMessage;
        readonly parts: ReadonlyArray<Part>;
      }> = [];
      const seenMessageIds = new Set<string>();
      let before: string | undefined = undefined;
      for (;;) {
        const response = yield* runOpenCodeSdk("session.messages", () =>
          client.session.messages({
            sessionID: sessionId,
            directory: workspaceRoot,
            limit: OPENCODE_PAGE_LIMIT,
            ...(before !== undefined ? { before } : {}),
          }),
        );
        const page = response.data ?? [];
        // Pages are ascending (oldest -> newest) and `before` walks backwards
        // in time, so the cursor is the oldest message of the page and each
        // page is prepended. Deduping by message id keeps overlapping pages
        // from producing duplicated messages.
        const fresh = page.filter((record) => !seenMessageIds.has(record.info.id));
        if (fresh.length === 0) break;
        for (const record of fresh) {
          seenMessageIds.add(record.info.id);
        }
        records.unshift(...fresh);
        // OpenCode returns an opaque pagination token in the response header.
        // A message id is not a valid `before` cursor.
        const nextBefore = response.response?.headers.get("X-Next-Cursor")?.trim() || undefined;
        if (nextBefore === undefined || nextBefore === before) {
          break;
        }
        before = nextBefore;
      }
      return records;
    });

  const importOpenCodeHistory = (
    input: ProviderSessionHistoryImportInput,
    settings: ServerSettings,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const opencode = defaultOpenCodeInstanceSettings(settings);
        if (!opencode.config.enabled) return [];
        const connection = yield* openCodeRuntime.connectToOpenCodeServer({
          binaryPath: opencode.config.binaryPath,
          serverUrl: opencode.config.serverUrl,
          environment: opencode.environment,
        });
        const client = openCodeRuntime.createOpenCodeSdkClient({
          baseUrl: connection.url,
          directory: input.workspaceRoot,
          ...(opencode.config.serverPassword.trim().length > 0
            ? { serverPassword: opencode.config.serverPassword }
            : {}),
        });

        const sessions = yield* listOpenCodeSessions(client, input.workspaceRoot);
        const normalizedWorkspaceRoot = normalizePathValue(path, input.workspaceRoot);
        const projectSessions = sessions.filter(
          (session) =>
            session.parentID === undefined &&
            normalizePathValue(path, session.directory) === normalizedWorkspaceRoot,
        );

        const imported: ReadonlyArray<ImportedHistorySession> = yield* Effect.forEach(
          projectSessions,
          (session) =>
            listOpenCodeMessages(client, input.workspaceRoot, session.id).pipe(
              Effect.map((records) => {
                const messages = records
                  .filter((record) =>
                    isOpenCodeMessageInProject(record.info, input.workspaceRoot, path),
                  )
                  .map((record) => importedMessageFromOpenCodeRecord(record, input.requestedAt))
                  .filter((message): message is ImportedHistoryMessage => message !== null)
                  // toSorted is stable, so same-timestamp messages keep the
                  // provider's chronological order.
                  .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
                return {
                  provider: OPENCODE_PROVIDER,
                  providerThreadId: session.id,
                  title: truncateTitle(
                    session.title,
                    previewTitle(messages, "Imported OpenCode session"),
                  ),
                  ...(session.model !== undefined
                    ? { model: `${session.model.providerID}/${session.model.id}` }
                    : {}),
                  createdAt: isoFromEpochMillis(session.time.created, input.requestedAt),
                  messages,
                } satisfies ImportedHistorySession;
              }),
            ),
          { concurrency: 2 },
        );
        return imported.filter((session) => session.messages.length > 0);
      }),
    );

  const importProviderHistory = (
    input: ProviderSessionHistoryImportInput,
    settings: ServerSettings,
    provider: ProviderDriverKindType,
  ): Effect.Effect<ReadonlyArray<ImportedHistorySession>, ProviderSessionHistoryImportError> => {
    const unavailable = (detail: string) =>
      Effect.fail(
        new ProviderSessionHistoryImportError({
          projectId: input.projectId,
          failures: [{ provider, detail }],
        }),
      );
    const normalizeFailure = <E>(
      effect: Effect.Effect<ReadonlyArray<ImportedHistorySession>, E>,
    ): Effect.Effect<ReadonlyArray<ImportedHistorySession>, ProviderSessionHistoryImportError> =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          const detail =
            provider === OPENCODE_PROVIDER
              ? openCodeRuntimeErrorDetail(Cause.squash(cause))
              : Cause.pretty(cause);
          return Effect.fail(
            new ProviderSessionHistoryImportError({
              projectId: input.projectId,
              failures: [{ provider, detail }],
            }),
          );
        }),
      );

    if (provider === CODEX_PROVIDER) {
      if (!defaultCodexInstanceSettings(settings).config.enabled) {
        return unavailable("The selected Codex provider is disabled or has invalid settings.");
      }
      return normalizeFailure(
        importCodexHistory(input, settings).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      );
    }
    if (provider === CLAUDE_PROVIDER) {
      if (!defaultClaudeInstanceSettings(settings).config.enabled) {
        return unavailable("The selected Claude provider is disabled or has invalid settings.");
      }
      return normalizeFailure(
        importClaudeHistory(input, settings).pipe(Effect.provideService(Path.Path, path)),
      );
    }
    if (provider === OPENCODE_PROVIDER) {
      if (!defaultOpenCodeInstanceSettings(settings).config.enabled) {
        return unavailable("The selected OpenCode provider is disabled or has invalid settings.");
      }
      return normalizeFailure(importOpenCodeHistory(input, settings));
    }
    if (
      provider === CURSOR_PROVIDER ||
      provider === DEVIN_PROVIDER ||
      provider === GROK_PROVIDER ||
      provider === KILOCODE_PROVIDER ||
      provider === GITHUB_COPILOT_PROVIDER
    ) {
      return unavailable(`Session history import is not supported for ${provider}.`);
    }
    return unavailable(`Unknown session history provider: ${provider}.`);
  };

  const importProjectHistory: ProviderSessionHistoryImporterShape["importProjectHistory"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const providers = [...new Set(input.providers)];
      if (providers.length === 0) return;
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (error) =>
            new ProviderSessionHistoryImportError({
              projectId: input.projectId,
              failures: providers.map((provider) => ({
                provider,
                detail:
                  error instanceof Error && error.message.trim().length > 0
                    ? error.message
                    : String(error),
              })),
            }),
        ),
      );
      const resolvedWorkspaceRoot = normalizePathValue(path, input.workspaceRoot);
      const canonicalWorkspaceRoot = yield* fs
        .realPath(resolvedWorkspaceRoot)
        .pipe(Effect.orElseSucceed(() => resolvedWorkspaceRoot));
      const normalizedInput: ProviderSessionHistoryImportInput = {
        ...input,
        workspaceRoot: canonicalWorkspaceRoot,
      };

      const failures: Array<{
        readonly provider: ProviderDriverKindType;
        readonly detail: string;
      }> = [];
      yield* Effect.forEach(
        providers,
        (provider) =>
          Effect.suspend(() =>
            importProviderHistory(normalizedInput, settings, provider).pipe(
              Effect.flatMap((sessions) =>
                Effect.forEach(
                  sessions
                    .map((session) =>
                      filterSessionToConsentWindow(session, normalizedInput.requestedAt),
                    )
                    .filter((session): session is ImportedHistorySession => session !== null),
                  (session) => dispatchImportedSession(normalizedInput, session),
                  {
                    concurrency: 1,
                    discard: true,
                  },
                ),
              ),
            ),
          ).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.interrupt;
              }
              const squashed = Cause.squash(cause);
              const detail =
                squashed instanceof ProviderSessionHistoryImportError
                  ? (squashed.failures.find((failure) => failure.provider === provider)?.detail ??
                    Cause.pretty(cause))
                  : provider === OPENCODE_PROVIDER
                    ? openCodeRuntimeErrorDetail(squashed)
                    : Cause.pretty(cause);
              return Effect.logWarning("provider session history import provider attempt failed", {
                projectId: normalizedInput.projectId,
                provider,
                detail,
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProviderSessionHistoryImportError({
                      projectId: normalizedInput.projectId,
                      failures: [{ provider, detail }],
                    }),
                  ),
                ),
              );
            }),
            Effect.retry({ times: PROVIDER_IMPORT_RETRY_COUNT }),
            Effect.tap(() =>
              Effect.logInfo("provider session history import provider completed", {
                projectId: normalizedInput.projectId,
                provider,
              }),
            ),
            Effect.catch((error) =>
              Effect.sync(() => {
                failures.push(...error.failures);
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      );

      if (failures.length > 0) {
        return yield* new ProviderSessionHistoryImportError({
          projectId: normalizedInput.projectId,
          failures,
        });
      }
    });

  return {
    importProjectHistory,
  } satisfies ProviderSessionHistoryImporterShape;
});

export const ProviderSessionHistoryImporterLive = Layer.effect(
  ProviderSessionHistoryImporter,
  make,
);
