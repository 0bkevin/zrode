import { ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { validateExpectedSteeringTurn } from "./Steering.ts";

it.effect("accepts the exact active turn and rejects stale steering", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("codex");
    const threadId = ThreadId.make("thread-steering");
    const activeTurnId = TurnId.make("turn-active");

    yield* validateExpectedSteeringTurn({
      provider,
      threadId,
      expectedTurnId: activeTurnId,
      activeTurnId,
    });

    const error = yield* validateExpectedSteeringTurn({
      provider,
      threadId,
      expectedTurnId: TurnId.make("turn-stale"),
      activeTurnId,
    }).pipe(Effect.flip);
    expect(error._tag).toBe("ProviderAdapterValidationError");
    expect(error.issue).toContain("no longer active");
  }),
);
