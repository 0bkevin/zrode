// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  KiloCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  KiloCodePromptSettlementBelongsToContext,
  makeKiloCodeAdapter,
} from "./KiloCodeAdapter.ts";

const decodeKiloCodeSettings = Schema.decodeSync(KiloCodeSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockKiloCodeWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kilocode-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-kilocode.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
if [ "$1" != "acp" ]; then
  printf "%s\\n" "unexpected args: $*" >&2
  exit 11
fi
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const kilocodeAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "zrode-kilocode-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeKiloCodeAdapter>[1]) =>
  makeKiloCodeAdapter(decodeKiloCodeSettings({ enabled: true, binaryPath }), options).pipe(
    Effect.orDie,
  );

it("rejects stale Kilo prompt settlements from replaced sessions and turns", () => {
  const turnId = TurnId.make("turn-1");
  assert.isTrue(
    KiloCodePromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: turnId,
      liveSessionActiveTurnId: turnId,
      turnId,
    }),
  );
  assert.isFalse(
    KiloCodePromptSettlementBelongsToContext({
      liveAcpSessionId: "session-2",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: turnId,
      liveSessionActiveTurnId: turnId,
      turnId,
    }),
  );
});

it.layer(kilocodeAdapterTestLayer)("KiloCodeAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kilocode-mock-thread");
      const requestLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "zrode-kilocode-adapter-log-")),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiloCodeWrapper({
          ZRODE_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kilocode"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kilocode"), model: "composer-2" },
      });

      assert.equal(session.provider, "kilocode");
      assert.equal(session.model, "composer-2");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello kilocode",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((event) => event.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            (request.params as Record<string, unknown> | undefined)?.configId === "model" &&
            (request.params as Record<string, unknown> | undefined)?.value === "composer-2",
        ),
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not authenticate or retry prompt auth failures", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kilocode-auth-retry-thread");
      const requestLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "zrode-kilocode-auth-retry-log-")),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiloCodeWrapper({
          ZRODE_ACP_REQUEST_LOG_PATH: requestLogPath,
          ZRODE_ACP_ADVERTISE_AUTH_METHODS: "1",
          ZRODE_ACP_AUTH_METHOD_ID: "kilo-login",
          ZRODE_ACP_REQUIRE_AUTH_FOR_PROMPT: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kilocode"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const promptError = yield* adapter
        .sendTurn({
          threadId,
          input: "hello after auth",
          attachments: [],
        })
        .pipe(Effect.flip);
      assert.include(promptError.message, "authentication required");

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.isDefined(completed);
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
      }

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.equal(requests.filter((request) => request.method === "session/prompt").length, 1);
      assert.isFalse(requests.some((request) => request.method === "authenticate"));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes an interrupted Kilo session so provider work cannot continue", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kilocode-interrupt-isolation-thread");
      const logDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "zrode-kilocode-cancel-log-")),
      );
      const requestLogPath = NodePath.join(logDir, "requests.ndjson");
      const exitLogPath = NodePath.join(logDir, "exit.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiloCodeWrapper({
          ZRODE_ACP_REQUEST_LOG_PATH: requestLogPath,
          ZRODE_ACP_EXIT_LOG_PATH: exitLogPath,
          ZRODE_ACP_PROMPT_DELAY_MS: "1000",
          ZRODE_ACP_REJECT_CLOSE_SESSION: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const events: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kilocode"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const first = yield* adapter
        .sendTurn({ threadId, input: "first", attachments: [] })
        .pipe(Effect.forkChild);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        yield* Effect.yieldNow;
      }
      const active = (yield* adapter.listSessions())[0]?.activeTurnId;
      assert.isDefined(active);
      yield* adapter.interruptTurn(threadId, active);

      yield* Fiber.join(first);
      assert.isFalse(yield* adapter.hasSession(threadId));
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.equal(requests.filter((request) => request.method === "session/close").length, 1);
      const exitLog = yield* Effect.promise(() => NodeFSP.readFile(exitLogPath, "utf8"));
      assert.match(exitLog, /(?:SIGTERM|exit:)/);
      const terminal = events.find((event) => event.type === "turn.completed");
      assert.isDefined(terminal);
      if (terminal?.type === "turn.completed") {
        assert.equal(terminal.payload.state, "cancelled");
      }
      yield* Fiber.interrupt(eventFiber);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kilocode"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const next = yield* adapter.sendTurn({ threadId, input: "after recovery", attachments: [] });
      assert.isDefined(next.turnId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not submit a prompt when cancellation wins during model preparation", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kilocode-cancel-preparation-thread");
      const logDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kilo-prep-")),
      );
      const requestLogPath = NodePath.join(logDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiloCodeWrapper({
          ZRODE_ACP_REQUEST_LOG_PATH: requestLogPath,
          ZRODE_ACP_HANG_SET_CONFIG_OPTION: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        closeTimeoutMs: 50,
        eventDrainTimeoutMs: 25,
      });
      const events: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "must not submit",
          attachments: [],
          modelSelection: { instanceId: ProviderInstanceId.make("kilocode"), model: "composer-2" },
        })
        .pipe(Effect.forkChild);
      let activeTurnId: TurnId | undefined;
      for (let attempt = 0; attempt < 100 && activeTurnId === undefined; attempt += 1) {
        activeTurnId = (yield* adapter.listSessions())[0]?.activeTurnId;
        if (activeTurnId === undefined) yield* Effect.yieldNow;
      }
      assert.isDefined(activeTurnId);
      yield* adapter.interruptTurn(threadId, activeTurnId).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.join(sendFiber).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.interrupt(eventFiber);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.equal(
        requests.filter((request) => request.method === "session/set_config_option").length,
        1,
      );
      assert.equal(requests.filter((request) => request.method === "session/prompt").length, 0);
      assert.equal(events.filter((event) => event.type === "turn.started").length, 0);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    }),
  );

  it.effect("drains partial content before committing a prompt failure", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kilocode-partial-failure-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiloCodeWrapper({
          ZRODE_ACP_FAIL_PROMPT: "1",
          ZRODE_ACP_EMIT_UPDATE_BEFORE_PROMPT_FAILURE: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const events: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter
        .sendTurn({ threadId, input: "fail after partial", attachments: [] })
        .pipe(Effect.flip);
      yield* Fiber.interrupt(eventFiber);

      const deltaIndex = events.findIndex((event) => event.type === "content.delta");
      const terminalIndex = events.findIndex((event) => event.type === "turn.completed");
      assert.isAtLeast(deltaIndex, 0);
      assert.isAbove(terminalIndex, deltaIndex);
      const delta = events[deltaIndex];
      const terminal = events[terminalIndex];
      assert.equal(delta?.turnId, terminal?.turnId);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    }),
  );

  it.effect("preserves a healthy session when its replacement fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kilocode-replacement-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiloCodeWrapper({ ZRODE_ACP_FAIL_LOAD_SESSION: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const original = yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter
        .startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "replacement-session" },
        })
        .pipe(Effect.flip);

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 1);
      assert.deepStrictEqual(sessions[0]?.resumeCursor, original.resumeCursor);
      const turn = yield* adapter.sendTurn({ threadId, input: "still healthy", attachments: [] });
      assert.isDefined(turn.turnId);
    }),
  );

  it.effect("bounds startup and prompt RPCs and tears down a timed-out prompt", () =>
    Effect.gen(function* () {
      const startupThread = ThreadId.make("kilocode-start-timeout-thread");
      const startupWrapper = yield* Effect.promise(() =>
        makeMockKiloCodeWrapper({ ZRODE_ACP_HANG_INITIALIZE: "1" }),
      );
      const startupAdapter = yield* makeTestAdapter(startupWrapper, { startTimeoutMs: 0 });
      const startupError = yield* startupAdapter
        .startSession({
          threadId: startupThread,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      assert.include(startupError.message, "timed out");
      assert.isFalse(yield* startupAdapter.hasSession(startupThread));

      const modelThread = ThreadId.make("kilocode-model-timeout-thread");
      const modelWrapper = yield* Effect.promise(() =>
        makeMockKiloCodeWrapper({ ZRODE_ACP_HANG_SET_CONFIG_OPTION: "1" }),
      );
      const modelAdapter = yield* makeTestAdapter(modelWrapper, {
        modelSelectionTimeoutMs: 0,
        closeTimeoutMs: 50,
      });
      yield* modelAdapter.startSession({
        threadId: modelThread,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const modelError = yield* modelAdapter
        .sendTurn({
          threadId: modelThread,
          input: "model timeout",
          attachments: [],
          modelSelection: { instanceId: ProviderInstanceId.make("kilocode"), model: "composer-2" },
        })
        .pipe(Effect.flip);
      assert.include(modelError.message, "timed out");
      assert.isFalse(yield* modelAdapter.hasSession(modelThread));

      const promptThread = ThreadId.make("kilocode-prompt-timeout-thread");
      const promptWrapper = yield* Effect.promise(() =>
        makeMockKiloCodeWrapper({ ZRODE_ACP_HANG_PROMPT_FOREVER: "1" }),
      );
      const promptAdapter = yield* makeTestAdapter(promptWrapper, {
        promptTimeoutMs: 0,
        closeTimeoutMs: 250,
      });
      yield* promptAdapter.startSession({
        threadId: promptThread,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const promptError = yield* promptAdapter
        .sendTurn({
          threadId: promptThread,
          input: "hang",
          attachments: [],
        })
        .pipe(Effect.flip);
      assert.include(promptError.message, "timed out");
      assert.isFalse(yield* promptAdapter.hasSession(promptThread));
    }),
  );
});
