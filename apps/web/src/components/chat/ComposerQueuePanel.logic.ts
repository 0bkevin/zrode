import type { MessageId } from "@t3tools/contracts";

export interface QueuedTurnPreviewInput {
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
}

export function reconcileQueuedTurnPreviews(input: {
  readonly serverQueuedTurns: ReadonlyArray<QueuedTurnPreviewInput>;
  readonly optimisticQueuedTurns: ReadonlyArray<QueuedTurnPreviewInput>;
  readonly hiddenMessageIds: ReadonlySet<MessageId>;
  readonly sentMessageIds: ReadonlySet<MessageId>;
}): ReadonlyArray<QueuedTurnPreviewInput> {
  const visible: QueuedTurnPreviewInput[] = [];
  const includedMessageIds = new Set<MessageId>();

  for (const turn of [...input.serverQueuedTurns, ...input.optimisticQueuedTurns]) {
    if (
      includedMessageIds.has(turn.messageId) ||
      input.hiddenMessageIds.has(turn.messageId) ||
      input.sentMessageIds.has(turn.messageId)
    ) {
      continue;
    }
    includedMessageIds.add(turn.messageId);
    visible.push(turn);
  }

  return visible;
}

export function queuedTurnPreview(
  turn: Pick<QueuedTurnPreviewInput, "text" | "attachments">,
): string {
  const text = turn.text.replace(/\s+/g, " ").trim();
  if (text.length > 0) {
    return text;
  }

  if (turn.attachments.length === 0) {
    return "Queued message";
  }

  return turn.attachments.length === 1 ? "1 attachment" : `${turn.attachments.length} attachments`;
}
