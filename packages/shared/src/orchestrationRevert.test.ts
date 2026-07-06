import { describe, expect, it } from "vite-plus/test";

import { retainMessagesAfterCheckpointRevert } from "./orchestrationRevert.ts";

interface TestMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly turnId: string | null;
  readonly createdAt: string;
}

const message = (
  id: string,
  role: TestMessage["role"],
  turnId: string | null,
  createdAt: string,
): TestMessage => ({ id, role, turnId, createdAt });

const retain = (input: {
  readonly messages: ReadonlyArray<TestMessage>;
  readonly retainedTurnIds: ReadonlySet<string>;
  readonly turnCount: number;
}) =>
  retainMessagesAfterCheckpointRevert({
    messages: input.messages,
    retainedTurnIds: input.retainedTurnIds,
    turnCount: input.turnCount,
    getId: (entry) => entry.id,
    getRole: (entry) => entry.role,
    getTurnId: (entry) => entry.turnId,
    getCreatedAt: (entry) => entry.createdAt,
  }).map((entry) => entry.id);

describe("retainMessagesAfterCheckpointRevert", () => {
  it("removes the first user message when turn count is 0", () => {
    expect(
      retain({
        messages: [
          message("system-1", "system", null, "2026-01-01T00:00:00.000Z"),
          message("user-1", "user", null, "2026-01-01T00:00:01.000Z"),
          message("assistant-1", "assistant", "turn-1", "2026-01-01T00:00:02.000Z"),
        ],
        retainedTurnIds: new Set(),
        turnCount: 0,
      }),
    ).toEqual(["system-1"]);
  });

  it("retains the first user and assistant pair for turn count 1", () => {
    expect(
      retain({
        messages: [
          message("user-1", "user", null, "2026-01-01T00:00:01.000Z"),
          message("assistant-1", "assistant", "turn-1", "2026-01-01T00:00:02.000Z"),
          message("user-2", "user", null, "2026-01-01T00:00:03.000Z"),
          message("assistant-2", "assistant", "turn-2", "2026-01-01T00:00:04.000Z"),
        ],
        retainedTurnIds: new Set(["turn-1"]),
        turnCount: 1,
      }),
    ).toEqual(["user-1", "assistant-1"]);
  });

  it("prunes messages from removed turns", () => {
    expect(
      retain({
        messages: [
          message("user-1", "user", null, "2026-01-01T00:00:01.000Z"),
          message("assistant-1", "assistant", "turn-1", "2026-01-01T00:00:02.000Z"),
          message("user-2", "user", null, "2026-01-01T00:00:03.000Z"),
          message("assistant-2", "assistant", "turn-2", "2026-01-01T00:00:04.000Z"),
        ],
        retainedTurnIds: new Set(["turn-1"]),
        turnCount: 1,
      }),
    ).not.toContain("assistant-2");
  });
});
