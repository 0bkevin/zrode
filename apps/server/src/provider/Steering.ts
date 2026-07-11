import type { ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProviderAdapterValidationError } from "./Errors.ts";

export function validateExpectedSteeringTurn(input: {
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly expectedTurnId: TurnId | undefined;
  readonly activeTurnId: TurnId | undefined;
}): Effect.Effect<void, ProviderAdapterValidationError> {
  if (input.expectedTurnId === undefined || input.activeTurnId === input.expectedTurnId) {
    return Effect.void;
  }
  return Effect.fail(
    new ProviderAdapterValidationError({
      provider: input.provider,
      operation: "sendTurn",
      issue: `Turn '${input.expectedTurnId}' is no longer active on thread '${input.threadId}'.`,
    }),
  );
}
