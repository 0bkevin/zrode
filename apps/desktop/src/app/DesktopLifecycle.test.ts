import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";

it.effect("releases graceful shutdown when cleanup never completes", () =>
  Effect.gen(function* () {
    const fiber = yield* DesktopLifecycle.requestDesktopShutdownAndWait().pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;
    assert.isUndefined(fiber.pollUnsafe());

    yield* TestClock.adjust(DesktopLifecycle.DESKTOP_GRACEFUL_SHUTDOWN_TIMEOUT);
    yield* Fiber.join(fiber);
  }).pipe(Effect.provide(DesktopShutdown.layer)),
);
