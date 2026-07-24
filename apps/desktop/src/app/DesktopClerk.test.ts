import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { createClerkBridgeMock, storageAdapter, storageMock } = vi.hoisted(() => ({
  createClerkBridgeMock: vi.fn(),
  storageAdapter: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  storageMock: vi.fn(),
}));

vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));

vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));

import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const makeDesktopClerkLayer = (isDevelopment = true) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/tmp/t3-state",
    isDevelopment,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  return DesktopClerk.layer.pipe(
    Layer.provide(Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment)),
  );
};

describe("DesktopClerk", () => {
  beforeEach(() => {
    createClerkBridgeMock.mockReset();
    storageMock.mockReset();
  });

  it("derives the Clerk Frontend API hostname used by the desktop CSP", () => {
    const publishableKey = `pk_test_${btoa("clerk.t3.codes$")}`;

    assert.equal(
      DesktopClerk.resolveDesktopClerkFrontendApiHostname(publishableKey),
      "clerk.t3.codes",
    );
    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname(""), undefined);
    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname("invalid"), undefined);
  });

  it.effect("acquires and releases the SDK bridge with the layer", () => {
    const cleanup = vi.fn();
    storageAdapter.getItem.mockResolvedValue(null);
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup });

    return Effect.scoped(
      Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        const bridgeOptions = createClerkBridgeMock.mock.calls[0]?.[0];
        assert.isDefined(bridgeOptions);
        assert.equal(storageMock.mock.calls.length, 0);
        assert.equal(bridgeOptions.passkeys, true);
        assert.deepEqual(bridgeOptions.renderer, { scheme: "zrode-dev", host: "app" });

        yield* clerk.activateStorage;
        assert.deepEqual(storageMock.mock.calls, [[{ path: "/tmp/t3-state" }]]);
        yield* Effect.promise(() => bridgeOptions.storage.getItem("token"));
        assert.deepEqual(storageAdapter.getItem.mock.calls, [["token"]]);
      }),
    ).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.ensuring(
        Effect.sync(() => {
          assert.equal(cleanup.mock.calls.length, 1);
        }),
      ),
    );
  });

  it.effect("preserves bridge initialization failures", () => {
    const cause = new Error("bridge initialization failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementationOnce(() => {
      throw cause;
    });

    return Effect.gen(function* () {
      const error = yield* Effect.scoped(Layer.build(makeDesktopClerkLayer())).pipe(Effect.flip);

      assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeInitializationError);
      assert.equal(error.stateDir, "/tmp/t3-state");
      assert.equal(error.isDevelopment, true);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        'Failed to initialize the desktop Clerk bridge for state directory "/tmp/t3-state" (development: true).',
      );
    });
  });

  it.effect("preserves bridge cleanup failures", () => {
    const cause = new Error("bridge cleanup failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({
      cleanup: () => {
        throw cause;
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(makeDesktopClerkLayer(false))));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeCleanupError);
        assert.equal(error.stateDir, "/tmp/t3-state");
        assert.equal(error.isDevelopment, false);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          'Failed to clean up the desktop Clerk bridge for state directory "/tmp/t3-state" (development: false).',
        );
      }
    });
  });

  it.each([
    { isDevelopment: true, scheme: "zrode-dev" },
    { isDevelopment: false, scheme: "zrode" },
  ])("configures the SDK with the $scheme renderer origin", ({ isDevelopment, scheme }) => {
    const bridge = { cleanup: vi.fn() };
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue(bridge);

    assert.equal(DesktopClerk.createDesktopClerkBridge("/tmp/t3-state", isDevelopment), bridge);
    assert.deepEqual(storageMock.mock.calls, [[{ path: "/tmp/t3-state" }]]);
    assert.deepEqual(createClerkBridgeMock.mock.calls, [
      [
        {
          storage: storageAdapter,
          passkeys: true,
          renderer: { scheme, host: "app" },
        },
      ],
    ]);
    storageMock.mockClear();
    createClerkBridgeMock.mockClear();
  });
});
