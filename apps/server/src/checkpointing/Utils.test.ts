import { CheckpointRef, ThreadId } from "@t3tools/contracts";
import * as Encoding from "effect/Encoding";
import { describe, expect, it } from "vite-plus/test";

import {
  checkpointBaselineRefForThreadTurnInManagedFamily,
  checkpointRefForThreadTurn,
  checkpointRefForThreadTurnInManagedFamily,
  isZrodeCheckpointRef,
} from "./Utils.ts";

describe("checkpoint ref namespace compatibility", () => {
  const threadId = ThreadId.make("thread-checkpoint-family");
  const encodedThreadId = Encoding.encodeBase64Url(threadId);

  it("writes new refs only in the Zrode namespace", () => {
    const checkpointRef = checkpointRefForThreadTurn(threadId, 3);

    expect(checkpointRef).toBe(`refs/zrode/checkpoints/${encodedThreadId}/turn/3`);
    expect(isZrodeCheckpointRef(checkpointRef, threadId)).toBe(true);
  });

  it("derives readable turn and baseline refs from a legacy T3 family", () => {
    const legacyRef = CheckpointRef.make(`refs/t3/checkpoints/${encodedThreadId}/turn/4`);

    expect(checkpointRefForThreadTurnInManagedFamily(legacyRef, threadId, 0)).toBe(
      `refs/t3/checkpoints/${encodedThreadId}/turn/0`,
    );
    expect(checkpointBaselineRefForThreadTurnInManagedFamily(legacyRef, threadId, 4)).toBe(
      `refs/t3/checkpoints/${encodedThreadId}/baseline/4`,
    );
    expect(isZrodeCheckpointRef(legacyRef, threadId)).toBe(false);
  });

  it("rejects foreign namespaces and refs belonging to another thread", () => {
    const foreignRef = CheckpointRef.make(`refs/other/checkpoints/${encodedThreadId}/turn/1`);
    const otherThreadRef = CheckpointRef.make(
      `refs/t3/checkpoints/${Encoding.encodeBase64Url("other-thread")}/turn/1`,
    );

    expect(checkpointRefForThreadTurnInManagedFamily(foreignRef, threadId, 0)).toBeNull();
    expect(checkpointRefForThreadTurnInManagedFamily(otherThreadRef, threadId, 0)).toBeNull();
    expect(isZrodeCheckpointRef(foreignRef)).toBe(false);
  });
});
