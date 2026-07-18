import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { CheckpointStore } from "./CheckpointStore.ts";
import { checkpointBaselineRefForThreadTurn, checkpointRefForThreadTurn } from "./Utils.ts";

/**
 * Capture the immutable refs needed to compare one turn against the exact
 * workspace state that existed before the provider received the prompt.
 */
export const captureTurnBaseline = Effect.fn("captureTurnBaseline")(function* (input: {
  readonly checkpointStore: CheckpointStore["Service"];
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly turnCount: number;
  /** Refresh a baseline left by an earlier turn-start attempt that never ran. */
  readonly refreshExisting?: boolean;
}) {
  const baselineCheckpointRef = checkpointBaselineRefForThreadTurn(input.threadId, input.turnCount);

  // Turn zero remains the stable root for full-thread diffs and reverts.
  if (input.turnCount === 1) {
    const rootCheckpointRef = checkpointRefForThreadTurn(input.threadId, 0);
    const rootExists = yield* input.checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: rootCheckpointRef,
    });
    if (!rootExists) {
      yield* input.checkpointStore.captureCheckpoint({
        cwd: input.cwd,
        checkpointRef: rootCheckpointRef,
        ifMissing: true,
      });
    }
  }

  const baselineExists =
    input.refreshExisting !== true &&
    (yield* input.checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: baselineCheckpointRef,
    }));
  if (!baselineExists) {
    yield* input.checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: baselineCheckpointRef,
      ifMissing: input.refreshExisting !== true,
    });
  }

  return baselineCheckpointRef;
});
