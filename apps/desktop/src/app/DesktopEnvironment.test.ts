import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/Zrode.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/Zrode.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(env))));

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  Effect.gen(function* () {
    return yield* DesktopEnvironment.DesktopEnvironment;
  }).pipe(Effect.provide(makeEnvironmentLayer(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("derives state paths and development identity inside Effect", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          ZRODE_HOME: " /tmp/zrode ",
          ZRODE_COMMIT_HASH: " 0123456789abcdef ",
          ZRODE_PORT: "4949",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          ZRODE_DEV_REMOTE_ZRODE_SERVER_ENTRY_PATH: " /remote/server.mjs ",
          ZRODE_OTLP_TRACES_URL: " http://127.0.0.1:4318/v1/traces ",
          ZRODE_OTLP_EXPORT_INTERVAL_MS: "2500",
        },
      );

      assert.equal(environment.isDevelopment, true);
      assert.equal(environment.appDataDirectory, "/Users/alice/Library/Application Support");
      assert.equal(environment.baseDir, "/tmp/zrode");
      assert.equal(environment.stateDir, "/tmp/zrode/dev");
      assert.equal(environment.desktopSettingsPath, "/tmp/zrode/dev/desktop-settings.json");
      assert.equal(environment.clientSettingsPath, "/tmp/zrode/dev/client-settings.json");
      assert.equal(
        environment.savedEnvironmentRegistryPath,
        "/tmp/zrode/dev/saved-environments.json",
      );
      assert.equal(environment.serverSettingsPath, "/tmp/zrode/dev/settings.json");
      assert.equal(environment.logDir, "/tmp/zrode/dev/logs");
      assert.equal(environment.rootDir, "/repo");
      assert.equal(environment.appRoot, "/repo");
      assert.equal(environment.backendEntryPath, "/repo/apps/server/dist/bin.mjs");
      assert.equal(environment.backendCwd, "/repo");
      assert.equal(environment.appUserModelId, "com.zrode.zrode.dev");
      assert.equal(environment.linuxWmClass, "zrode-dev");
      assert.deepEqual(
        Option.map(environment.devServerUrl, (url) => url.href),
        Option.some("http://localhost:5173/"),
      );
      assert.deepEqual(
        environment.devRemoteZrodeServerEntryPath,
        Option.some("/remote/server.mjs"),
      );
      assert.deepEqual(environment.configuredBackendPort, Option.some(4949));
      assert.deepEqual(environment.commitHashOverride, Option.some("0123456789abcdef"));
      assert.deepEqual(environment.otlpTracesUrl, Option.some("http://127.0.0.1:4318/v1/traces"));
      assert.equal(environment.otlpExportIntervalMs, 2500);
    }),
  );

  it.effect("derives production state paths under userdata", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          ZRODE_HOME: "/tmp/zrode",
        },
      );

      assert.equal(environment.isDevelopment, false);
      assert.equal(environment.stateDir, "/tmp/zrode/userdata");
      assert.equal(environment.logDir, "/tmp/zrode/userdata/logs");
      assert.equal(environment.serverSettingsPath, "/tmp/zrode/userdata/settings.json");
    }),
  );

  it.effect("resolves picker defaults without nullish sentinels", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();

      assert.deepEqual(environment.resolvePickFolderDefaultPath(null), Option.none());
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: " " }),
        Option.none(),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~" }),
        Option.some("/Users/alice"),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~/project" }),
        Option.some("/Users/alice/project"),
      );
    }),
  );
});
