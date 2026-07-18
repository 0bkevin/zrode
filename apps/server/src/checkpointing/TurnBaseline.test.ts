import { ThreadId, type CheckpointRef } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import type * as CheckpointStore from "./CheckpointStore.ts";
import { captureTurnBaseline } from "./TurnBaseline.ts";
import { checkpointBaselineRefForThreadTurn, checkpointRefForThreadTurn } from "./Utils.ts";

describe("captureTurnBaseline", () => {
  it.effect("refreshes a retried turn baseline without moving the stable root", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-baseline-retry");
      const existingRefs = new Set<CheckpointRef>();
      const captureCalls: Array<{ checkpointRef: CheckpointRef; ifMissing: boolean | undefined }> =
        [];
      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        hasCheckpointRef: ({ checkpointRef }) => Effect.succeed(existingRefs.has(checkpointRef)),
        captureCheckpoint: ({ checkpointRef, ifMissing }) =>
          Effect.sync(() => {
            captureCalls.push({ checkpointRef, ifMissing });
            existingRefs.add(checkpointRef);
          }),
        restoreCheckpoint: () => Effect.succeed(false),
        diffCheckpoints: () => Effect.succeed(""),
        deleteCheckpointRefs: () => Effect.void,
      };

      yield* captureTurnBaseline({
        checkpointStore,
        cwd: "/tmp/workspace",
        threadId,
        turnCount: 1,
        refreshExisting: true,
      });
      yield* captureTurnBaseline({
        checkpointStore,
        cwd: "/tmp/workspace",
        threadId,
        turnCount: 1,
        refreshExisting: true,
      });

      expect(captureCalls).toEqual([
        { checkpointRef: checkpointRefForThreadTurn(threadId, 0), ifMissing: true },
        {
          checkpointRef: checkpointBaselineRefForThreadTurn(threadId, 1),
          ifMissing: false,
        },
        {
          checkpointRef: checkpointBaselineRefForThreadTurn(threadId, 1),
          ifMissing: false,
        },
      ]);
    }),
  );
});
