import type { QueuedThreadMessage } from "./thread-outbox-model";
import { clearOptimisticThreadDispatch } from "./thread-optimistic-dispatch";

export async function removeDroppedThreadOutboxMessage(input: {
  readonly message: QueuedThreadMessage;
  readonly remove: (message: QueuedThreadMessage) => Promise<void>;
  readonly warning: string;
  readonly warn?: (message: string, details: Readonly<Record<string, unknown>>) => void;
}): Promise<boolean> {
  try {
    await input.remove(input.message);
    clearOptimisticThreadDispatch({
      environmentId: input.message.environmentId,
      threadId: input.message.threadId,
      messageId: input.message.messageId,
      commandId: input.message.commandId,
    });
    return true;
  } catch (error) {
    (input.warn ?? console.warn)(input.warning, {
      environmentId: input.message.environmentId,
      threadId: input.message.threadId,
      messageId: input.message.messageId,
      error,
    });
    return false;
  }
}
