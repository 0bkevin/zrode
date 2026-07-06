export type RevertRetainMessageRole = "user" | "assistant" | "system";

export interface RetainMessagesAfterCheckpointRevertInput<TMessage> {
  readonly messages: ReadonlyArray<TMessage>;
  readonly retainedTurnIds: ReadonlySet<string>;
  readonly turnCount: number;
  readonly initiallyRetainedIds?: Iterable<string> | undefined;
  readonly getId: (message: TMessage) => string;
  readonly getRole: (message: TMessage) => RevertRetainMessageRole;
  readonly getTurnId: (message: TMessage) => string | null;
  readonly getCreatedAt: (message: TMessage) => string;
}

function compareFallbackMessages<TMessage>(
  input: Pick<RetainMessagesAfterCheckpointRevertInput<TMessage>, "getCreatedAt" | "getId">,
  left: TMessage,
  right: TMessage,
): number {
  return (
    input.getCreatedAt(left).localeCompare(input.getCreatedAt(right)) ||
    input.getId(left).localeCompare(input.getId(right))
  );
}

export function retainMessagesAfterCheckpointRevert<TMessage>(
  input: RetainMessagesAfterCheckpointRevertInput<TMessage>,
): TMessage[] {
  const turnCount = Math.max(0, Math.floor(input.turnCount));
  const retainedMessageIds = new Set<string>(input.initiallyRetainedIds ?? []);

  for (const message of input.messages) {
    if (input.getRole(message) === "system") {
      retainedMessageIds.add(input.getId(message));
      continue;
    }

    const turnId = input.getTurnId(message);
    if (turnId !== null && input.retainedTurnIds.has(turnId)) {
      retainedMessageIds.add(input.getId(message));
    }
  }

  for (const role of ["user", "assistant"] as const) {
    const retainedRoleCount = input.messages.filter(
      (message) => input.getRole(message) === role && retainedMessageIds.has(input.getId(message)),
    ).length;
    const missingRoleCount = Math.max(0, turnCount - retainedRoleCount);
    if (missingRoleCount === 0) {
      continue;
    }

    const fallbackMessages = input.messages
      .filter((message) => {
        if (input.getRole(message) !== role) {
          return false;
        }
        if (retainedMessageIds.has(input.getId(message))) {
          return false;
        }
        const turnId = input.getTurnId(message);
        return turnId === null || input.retainedTurnIds.has(turnId);
      })
      .toSorted((left, right) => compareFallbackMessages(input, left, right))
      .slice(0, missingRoleCount);

    for (const message of fallbackMessages) {
      retainedMessageIds.add(input.getId(message));
    }
  }

  return input.messages.filter((message) => retainedMessageIds.has(input.getId(message)));
}
