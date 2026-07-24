import { describe, expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { removeDroppedThreadOutboxMessage } from "./thread-outbox-drop";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import {
  optimisticThreadDispatchesAtom,
  registerOptimisticThreadDispatch,
} from "./thread-optimistic-dispatch";

const environmentId = EnvironmentId.make("environment-drop");
const threadId = ThreadId.make("thread-drop");
const messageId = MessageId.make("message-drop");
const commandId = CommandId.make("command-drop");
const queuedMessage: QueuedThreadMessage = {
  environmentId,
  threadId,
  messageId,
  commandId,
  text: "queued",
  attachments: [],
  createdAt: "2026-07-23T10:00:00.000Z",
};

describe("removeDroppedThreadOutboxMessage", () => {
  it("removes the durable item and its matching optimistic Working state together", async () => {
    appAtomRegistry.set(optimisticThreadDispatchesAtom, {});
    registerOptimisticThreadDispatch({
      environmentId,
      threadId,
      messageId,
      commandId,
      startedAt: queuedMessage.createdAt,
      thread: null,
    });
    const removed: QueuedThreadMessage[] = [];

    const result = await removeDroppedThreadOutboxMessage({
      message: queuedMessage,
      remove: async (message) => {
        removed.push(message);
      },
      warning: "drop failed",
    });

    expect(result).toBe(true);
    expect(removed).toEqual([queuedMessage]);
    expect(appAtomRegistry.get(optimisticThreadDispatchesAtom)).toEqual({});
  });

  it("keeps optimistic state when durable removal fails and the item remains queued", async () => {
    appAtomRegistry.set(optimisticThreadDispatchesAtom, {});
    registerOptimisticThreadDispatch({
      environmentId,
      threadId,
      messageId,
      commandId,
      startedAt: queuedMessage.createdAt,
      thread: null,
    });
    const warnings: Array<Readonly<Record<string, unknown>>> = [];

    const result = await removeDroppedThreadOutboxMessage({
      message: queuedMessage,
      remove: async () => {
        throw new Error("storage unavailable");
      },
      warning: "drop failed",
      warn: (_message, details) => {
        warnings.push(details);
      },
    });

    expect(result).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(appAtomRegistry.get(optimisticThreadDispatchesAtom)).toHaveProperty(
      scopedThreadKey(environmentId, threadId),
    );
    appAtomRegistry.set(optimisticThreadDispatchesAtom, {});
  });
});
