import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ClientOrchestrationCommand,
  ModelSelection,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationLatestTurn,
  OrchestrationThread,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  OrchestrationProposedPlan,
  OrchestrationSession,
  ProjectCreateCommand,
  ThreadMetaUpdatedPayload,
  ThreadTurnStartCommand,
  ThreadCreatedPayload,
  ThreadTurnDiff,
  ThreadTurnStartRequestedPayload,
  ProjectSessionHistoryImportRequestedPayload,
} from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);
const decodeFullThreadDiffInput = Schema.decodeUnknownEffect(OrchestrationGetFullThreadDiffInput);
const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);
const decodeProjectCreateCommand = Schema.decodeUnknownEffect(ProjectCreateCommand);
const decodeProjectCreatedPayload = Schema.decodeUnknownEffect(ProjectCreatedPayload);
const decodeProjectSessionHistoryImportRequestedPayload = Schema.decodeUnknownEffect(
  ProjectSessionHistoryImportRequestedPayload,
);
const decodeProjectMetaUpdatedPayload = Schema.decodeUnknownEffect(ProjectMetaUpdatedPayload);
const decodeThreadTurnStartCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeOrchestrationLatestTurn = Schema.decodeUnknownEffect(OrchestrationLatestTurn);
const decodeOrchestrationProposedPlan = Schema.decodeUnknownEffect(OrchestrationProposedPlan);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeOrchestrationThread = Schema.decodeUnknownEffect(OrchestrationThread);
const encodeThreadCreatedPayload = Schema.encodeEffect(ThreadCreatedPayload);

function getOptionValue(
  options: ReadonlyArray<{ id: string; value: unknown }> | undefined,
  id: string,
): unknown {
  return options?.find((option) => option.id === id)?.value;
}
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);

it.effect("parses turn diff input when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    assert.strictEqual(parsed.fromTurnCount, 1);
    assert.strictEqual(parsed.toTurnCount, 2);
  }),
);

it.effect("parses turn diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    assert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

it.effect("parses full thread diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFullThreadDiffInput({
      threadId: "thread-1",
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    assert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

it.effect("rejects turn diff input when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects thread turn diff when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeThreadTurnDiff({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        diff: "patch",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims branded ids and command string fields at decode boundaries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: " cmd-1 ",
      projectId: " project-1 ",
      title: " Project Title ",
      workspaceRoot: " /tmp/workspace ",
      defaultModelSelection: {
        provider: "codex",
        model: " gpt-5.2 ",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.commandId, "cmd-1");
    assert.strictEqual(parsed.projectId, "project-1");
    assert.strictEqual(parsed.title, "Project Title");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.strictEqual(parsed.createWorkspaceRootIfMissing, undefined);
    assert.deepStrictEqual(parsed.defaultModelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.2",
    });
  }),
);

it.effect("decodes project.create with createWorkspaceRootIfMissing enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: "cmd-1",
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      createWorkspaceRootIfMissing: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.createWorkspaceRootIfMissing, true);
  }),
);

it.effect("decodes project.create with session history import enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: "cmd-1",
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      importSessionHistory: true,
      sessionHistoryImportProviders: ["codex", "claudeAgent"],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.importSessionHistory, true);
    assert.deepStrictEqual(parsed.sessionHistoryImportProviders, [
      ProviderDriverKind.make("codex"),
      ProviderDriverKind.make("claudeAgent"),
    ]);
  }),
);

it.effect("decodes project session history import request payloads", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectSessionHistoryImportRequestedPayload({
      projectId: "project-1",
      workspaceRoot: "/tmp/workspace",
      providers: ["codex", "opencode"],
      requestedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.projectId, "project-1");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.deepStrictEqual(parsed.providers, [
      ProviderDriverKind.make("codex"),
      ProviderDriverKind.make("opencode"),
    ]);
    assert.strictEqual(parsed.requestedAt, "2026-01-01T00:00:00.000Z");
  }),
);

it.effect(
  "decodes legacy project session history import request payloads with empty providers",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeProjectSessionHistoryImportRequestedPayload({
        projectId: "project-1",
        workspaceRoot: "/tmp/workspace",
        requestedAt: "2026-01-01T00:00:00.000Z",
      });

      assert.deepStrictEqual(parsed.providers, []);
    }),
);

it.effect("decodes project session history import request events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "evt-project-import-history",
      aggregateKind: "project",
      aggregateId: "project-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-1",
      causationEventId: null,
      correlationId: "cmd-1",
      metadata: {},
      type: "project.session-history-import-requested",
      payload: {
        projectId: "project-1",
        workspaceRoot: "/tmp/workspace",
        providers: ["codex"],
        requestedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    assert.strictEqual(parsed.type, "project.session-history-import-requested");
    if (parsed.type !== "project.session-history-import-requested") return;
    assert.strictEqual(parsed.payload.projectId, "project-1");
    assert.deepStrictEqual(parsed.payload.providers, [ProviderDriverKind.make("codex")]);
  }),
);

it.effect("decodes retired title-generation events for historical replay", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationEvent({
      sequence: 156,
      eventId: "evt-title-generation-requested",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: "2026-06-02T20:23:37.717Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.title-generation-requested",
      payload: {
        threadId: "thread-1",
        message: "Terminal command: git status",
        titleSeed: "git status",
        createdAt: "2026-06-02T20:23:37.717Z",
      },
    });

    assert.strictEqual(parsed.type, "thread.title-generation-requested");
    if (parsed.type !== "thread.title-generation-requested") return;
    assert.strictEqual(parsed.payload.threadId, "thread-1");
    assert.strictEqual(parsed.payload.titleSeed, "git status");
  }),
);

it.effect("decodes internal thread history import commands", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "thread.history.import",
      commandId: "cmd-history-import",
      threadId: "thread-history-import",
      projectId: "project-1",
      title: "Imported Session",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.4",
      },
      provider: "codex",
      providerThreadId: "codex-thread-1",
      messages: [
        {
          messageId: "message-1",
          role: "user",
          text: "Hello",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.type, "thread.history.import");
    if (parsed.type !== "thread.history.import") return;
    assert.strictEqual(parsed.provider, ProviderDriverKind.make("codex"));
    assert.strictEqual(parsed.messages[0]?.role, "user");
  }),
);

it.effect("decodes project session history import completed events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "evt-project-import-history-completed",
      aggregateKind: "project",
      aggregateId: "project-1",
      occurredAt: "2026-01-01T00:00:05.000Z",
      commandId: "cmd-2",
      causationEventId: null,
      correlationId: "cmd-2",
      metadata: {},
      type: "project.session-history-import-completed",
      payload: {
        projectId: "project-1",
        requestEventId: "evt-project-import-history",
        completedAt: "2026-01-01T00:00:05.000Z",
      },
    });

    assert.strictEqual(parsed.type, "project.session-history-import-completed");
    if (parsed.type !== "project.session-history-import-completed") return;
    assert.strictEqual(parsed.payload.projectId, "project-1");
    assert.strictEqual(parsed.payload.requestEventId, "evt-project-import-history");
  }),
);

it.effect("decodes internal project session history import complete commands", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "project.session-history-import.complete",
      commandId: "cmd-history-import-complete",
      projectId: "project-1",
      requestEventId: "evt-project-import-history",
      createdAt: "2026-01-01T00:00:05.000Z",
    });

    assert.strictEqual(parsed.type, "project.session-history-import.complete");
    if (parsed.type !== "project.session-history-import.complete") return;
    assert.strictEqual(parsed.projectId, "project-1");
    assert.strictEqual(parsed.requestEventId, "evt-project-import-history");
  }),
);

it.effect("decodes historical project.created payloads with a default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "codex");
  }),
);

it.effect("decodes project.meta-updated payloads with explicit default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectMetaUpdatedPayload({
      projectId: "project-1",
      defaultModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "claudeAgent");
  }),
);

it.effect("rejects command fields that become empty after trim", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeProjectCreateCommand({
        type: "project.create",
        commandId: "cmd-1",
        projectId: "project-1",
        title: "  ",
        workspaceRoot: "/tmp/workspace",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes thread.turn.start defaults for provider and runtime mode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-1",
      threadId: "thread-1",
      message: {
        messageId: "msg-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection, undefined);
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("preserves explicit provider and runtime mode in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-2",
      threadId: "thread-1",
      message: {
        messageId: "msg-2",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    assert.strictEqual(parsed.runtimeMode, "full-access");
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("accepts bootstrap metadata in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-bootstrap",
      threadId: "thread-1",
      message: {
        messageId: "msg-bootstrap",
        role: "user",
        text: "hello",
        attachments: [],
      },
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "Bootstrap thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        prepareWorktree: {
          projectCwd: "/tmp/workspace",
          baseBranch: "main",
          branch: "zrode/example",
          startFromOrigin: true,
        },
        runSetupScript: true,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.bootstrap?.createThread?.projectId, "project-1");
    assert.strictEqual(parsed.bootstrap?.prepareWorktree?.baseBranch, "main");
    assert.strictEqual(parsed.bootstrap?.prepareWorktree?.startFromOrigin, true);
    assert.strictEqual(parsed.bootstrap?.runSetupScript, true);
  }),
);

it.effect("decodes thread.created runtime mode for historical events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.modelSelection.instanceId, "codex");
  }),
);

it.effect("decodes thread.meta-updated payloads with explicit provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "claudeAgent");
  }),
);

it.effect("decodes thread archive and unarchive commands", () =>
  Effect.gen(function* () {
    const archive = yield* decodeOrchestrationCommand({
      type: "thread.archive",
      commandId: "cmd-archive-1",
      threadId: "thread-1",
    });
    const unarchive = yield* decodeOrchestrationCommand({
      type: "thread.unarchive",
      commandId: "cmd-unarchive-1",
      threadId: "thread-1",
    });

    assert.strictEqual(archive.type, "thread.archive");
    assert.strictEqual(unarchive.type, "thread.unarchive");
  }),
);

it.effect("decodes thread archived and unarchived events", () =>
  Effect.gen(function* () {
    const archived = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-archive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.archived",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-archive-1",
      causationEventId: null,
      correlationId: "cmd-archive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        archivedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unarchived = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unarchive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unarchived",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unarchive-1",
      causationEventId: null,
      correlationId: "cmd-unarchive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    if (archived.type !== "thread.archived") {
      assert.fail(`Expected thread.archived event, received ${archived.type}.`);
    }
    assert.strictEqual(archived.payload.archivedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(unarchived.type, "thread.unarchived");
  }),
);

it.effect("accepts provider-scoped model options in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-options",
      threadId: "thread-1",
      message: {
        messageId: "msg-options",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    assert.strictEqual(getOptionValue(parsed.modelSelection?.options, "reasoningEffort"), "high");
    assert.strictEqual(getOptionValue(parsed.modelSelection?.options, "fastMode"), true);
  }),
);

it.effect("normalizes legacy object-shaped modelSelection.options on decode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Legacy options thread",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          effort: "max",
          fastMode: true,
          // Falsy/garbage entries are dropped, matching migration 026.
          emptyStr: "   ",
          nullish: null,
          nested: { foo: 1 },
        },
      },
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.modelSelection.instanceId, ProviderInstanceId.make("claudeAgent"));
    assert.deepStrictEqual(parsed.modelSelection.options, [
      { id: "effort", value: "max" },
      { id: "fastMode", value: true },
    ]);
  }),
);

it.effect("normalizes legacy object-shaped defaultModelSelection.options on decode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Legacy default project",
      workspaceRoot: "/tmp/legacy",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
        options: { reasoningEffort: "low" },
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.deepStrictEqual(parsed.defaultModelSelection?.options, [
      { id: "reasoningEffort", value: "low" },
    ]);
  }),
);

it.effect(
  "normalizes legacy object-shaped options on decode and re-encodes as canonical array",
  () =>
    Effect.gen(function* () {
      const decoded = yield* decodeThreadCreatedPayload({
        threadId: "thread-1",
        projectId: "project-1",
        title: "Round trip thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
          options: { fastMode: true },
        },
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const encoded = yield* encodeThreadCreatedPayload(decoded);
      assert.deepStrictEqual(encoded.modelSelection.options, [{ id: "fastMode", value: true }]);
    }),
);

it.effect("accepts a title seed in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-title-seed",
      threadId: "thread-1",
      message: {
        messageId: "msg-title-seed",
        role: "user",
        text: "hello",
        attachments: [],
      },
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("accepts a source proposed plan reference in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-source-plan",
      threadId: "thread-2",
      message: {
        messageId: "msg-source-plan",
        role: "user",
        text: "implement this",
        attachments: [],
      },
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes thread.last-user-message.edit commands", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "thread.last-user-message.edit",
      commandId: "cmd-edit",
      threadId: "thread-1",
      messageId: "msg-user-1",
      text: "Edited prompt",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      titleSeed: "Edited prompt",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.type, "thread.last-user-message.edit");
    if (parsed.type === "thread.last-user-message.edit") {
      assert.strictEqual(parsed.text, "Edited prompt");
      assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    }
  }),
);

it.effect("decodes queued turn steer commands", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeClientOrchestrationCommand({
      type: "thread.queued-turn.steer",
      commandId: "cmd-steer-queued",
      threadId: "thread-1",
      messageId: "message-queued-1",
      expectedTurnId: "turn-active-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.type, "thread.queued-turn.steer");
    if (parsed.type !== "thread.queued-turn.steer") return;
    assert.strictEqual(parsed.messageId, "message-queued-1");
    assert.strictEqual(parsed.expectedTurnId, "turn-active-1");
  }),
);

it.effect("rejects queued turn steer commands without an expected turn", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeClientOrchestrationCommand({
        type: "thread.queued-turn.steer",
        commandId: "cmd-steer-queued",
        threadId: "thread-1",
        messageId: "message-queued-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects malformed thread.last-user-message.edit commands", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeOrchestrationCommand({
        type: "thread.last-user-message.edit",
        commandId: "cmd-edit",
        threadId: "thread-1",
        messageId: "msg-user-1",
        text: "Edited prompt",
        titleSeed: "   ",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect(
  "decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(parsed.modelSelection, undefined);
      assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
      assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      assert.strictEqual(parsed.sourceProposedPlan, undefined);
    }),
);

it.effect("decodes thread.turn-start-requested source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes thread.turn-start-requested title seed when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("decodes thread.last-user-message-edit-requested events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationEvent({
      sequence: 10,
      eventId: "event-edit-requested",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.last-user-message-edit-requested",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-edit",
      causationEventId: null,
      correlationId: "cmd-edit",
      metadata: {},
      payload: {
        threadId: "thread-1",
        messageId: "msg-user-1",
        text: "Edited prompt",
        targetTurnCount: 0,
        checkpointTurnId: "turn-1",
        checkpointTurnCount: 1,
        expectedCurrentTurnCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    assert.strictEqual(parsed.type, "thread.last-user-message-edit-requested");
    if (parsed.type === "thread.last-user-message-edit-requested") {
      assert.strictEqual(parsed.payload.targetTurnCount, 0);
      assert.strictEqual(parsed.payload.checkpointTurnId, "turn-1");
      assert.strictEqual(parsed.payload.checkpointTurnCount, 1);
      assert.strictEqual(parsed.payload.expectedCurrentTurnCount, 1);
      assert.strictEqual(parsed.payload.text, "Edited prompt");
    }
  }),
);

it.effect("rejects malformed thread.last-user-message-edit-requested events", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeOrchestrationEvent({
        sequence: 10,
        eventId: "event-edit-requested",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        type: "thread.last-user-message-edit-requested",
        occurredAt: "2026-01-01T00:00:00.000Z",
        commandId: "cmd-edit",
        causationEventId: null,
        correlationId: "cmd-edit",
        metadata: {},
        payload: {
          threadId: "thread-1",
          messageId: "msg-user-1",
          text: "Edited prompt",
          targetTurnCount: -1,
          checkpointTurnId: "turn-1",
          checkpointTurnCount: 1,
          expectedCurrentTurnCount: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes latest turn source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationLatestTurn({
      turnId: "turn-2",
      state: "running",
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes orchestration session runtime mode defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "idle",
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
  }),
);

it.effect("defaults proposed plan implementation metadata for historical rows", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, null);
    assert.strictEqual(parsed.implementationThreadId, null);
  }),
);

it.effect("preserves proposed plan implementation metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-2",
      turnId: "turn-2",
      planMarkdown: "# Plan",
      implementedAt: "2026-01-02T00:00:00.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, "2026-01-02T00:00:00.000Z");
    assert.strictEqual(parsed.implementationThreadId, "thread-2");
  }),
);

// ── ModelSelection: instance-keyed wire shape + legacy decoder ────────
//
// `ModelSelection` is routing-keyed on `instanceId` — never a driver kind.
// Persisted and in-flight payloads from pre-instance builds carry a
// `provider` field whose value was a driver kind; those payloads are migrated
// at the wire boundary by
// promoting `provider` to the default instance id for that driver
// (built-in drivers use the driver kind slug as their default instance id, so
// the migration is a 1:1 rename).
//
// These tests pin the rollback/fork tolerance invariant: legacy payloads
// decode cleanly for fork-provided drivers, and the decoded form uses
// `instanceId` uniformly regardless of origin.

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const encodeModelSelection = Schema.encodeUnknownEffect(ModelSelection);

it.effect("ModelSelection migrates legacy `provider` field to `instanceId`", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      model: "gpt-5-codex",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex"));
    assert.strictEqual(parsed.model, "gpt-5-codex");
    assert.deepStrictEqual(parsed.options, [{ id: "reasoningEffort", value: "high" }]);
  }),
);

it.effect("ModelSelection accepts an explicit instanceId routing key", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect("ModelSelection prefers explicit instanceId over legacy provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect(
  "ModelSelection decodes unknown driver kinds via legacy provider (rollback / fork invariant)",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeModelSelection({
        provider: "ollama",
        model: "llama3:70b",
        options: [{ id: "temperature", value: "0.4" }],
      });
      assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("ollama"));
      assert.strictEqual(parsed.model, "llama3:70b");
    }),
);

it.effect("ModelSelection encodes to the canonical instanceId wire form", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeModelSelection({
      provider: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
    const encoded = yield* encodeModelSelection(decoded);
    assert.deepStrictEqual(encoded, {
      instanceId: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
  }),
);

it.effect("ModelSelection rejects malformed instance ids", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeModelSelection({
        instanceId: "1invalid", // must start with a letter
        model: "x",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes legacy thread.created payloads without handoffSource", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      runtimeMode: DEFAULT_RUNTIME_MODE,
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.handoffSource, undefined);
  }),
);

it.effect("decodes thread.created payloads carrying a handoffSource", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-2",
      projectId: "project-1",
      title: "Handoff: Thread title",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      runtimeMode: DEFAULT_RUNTIME_MODE,
      branch: null,
      worktreePath: null,
      handoffSource: {
        threadId: "thread-1",
        method: "summary",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    assert.deepStrictEqual(parsed.handoffSource, {
      threadId: "thread-1",
      method: "summary",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
  }),
);

it.effect("decodes legacy thread snapshots without handoffSource to null", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationThread({
      id: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    });

    assert.strictEqual(parsed.handoffSource, null);
  }),
);
