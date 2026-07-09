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
  GitHubCopilotSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeGitHubCopilotAdapter } from "./GitHubCopilotAdapter.ts";

const decodeGitHubCopilotSettings = Schema.decodeSync(GitHubCopilotSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockCopilotWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "github-copilot-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-copilot.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
if [ "$1" != "--acp" ] || [ "$2" != "--stdio" ]; then
  printf "%s\\n" "unexpected args: $*" >&2
  exit 11
fi
if [ "$COPILOT_MODEL" != "gpt-5.4" ]; then
  printf "%s\\n" "unexpected COPILOT_MODEL: $COPILOT_MODEL" >&2
  exit 12
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

const gitHubCopilotAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "zrode-github-copilot-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (
  binaryPath: string,
  options?: Parameters<typeof makeGitHubCopilotAdapter>[1],
) =>
  makeGitHubCopilotAdapter(
    decodeGitHubCopilotSettings({ enabled: true, binaryPath }),
    options,
  ).pipe(Effect.orDie);

it.layer(gitHubCopilotAdapterTestLayer)("GitHubCopilotAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("github-copilot-mock-thread");
      const requestLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "zrode-github-copilot-adapter-log-")),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockCopilotWrapper({
          ZRODE_ACP_REQUEST_LOG_PATH: requestLogPath,
          ZRODE_ACP_ADVERTISE_AUTH_METHODS: "1",
          ZRODE_ACP_AUTH_METHOD_ID: "copilot-login",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        environment: { GH_TOKEN: "secret" },
      });

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
        provider: ProviderDriverKind.make("githubCopilot"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("githubCopilot"),
          model: "gpt-5.4",
        },
      });

      assert.equal(session.provider, "githubCopilot");
      assert.equal(session.model, "gpt-5.4");
      assert.isUndefined(session.resumeCursor);

      yield* adapter.sendTurn({
        threadId,
        input: "hello copilot",
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
      assert.isFalse(requests.some((request) => request.method === "authenticate"));
      assert.isFalse(requests.some((request) => request.method === "session/set_model"));
      assert.isFalse(requests.some((request) => request.method === "session/set_config_option"));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects unsupported resume cursors explicitly", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter("copilot");
      const error = yield* Effect.flip(
        adapter.startSession({
          threadId: ThreadId.make("github-copilot-resume-not-supported"),
          provider: ProviderDriverKind.make("githubCopilot"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: { sessionId: "existing-acp-session" },
          modelSelection: {
            instanceId: ProviderInstanceId.make("githubCopilot"),
            model: "gpt-5.4",
          },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag !== "ProviderAdapterValidationError") {
        return;
      }
      assert.match(error.issue, /persistent resume is not supported/);
    }),
  );
});
