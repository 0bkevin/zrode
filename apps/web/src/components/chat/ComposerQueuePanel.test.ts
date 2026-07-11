import { describe, expect, it } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";

import { queuedTurnPreview, reconcileQueuedTurnPreviews } from "./ComposerQueuePanel.logic";

describe("queuedTurnPreview", () => {
  it("normalizes message whitespace for a compact single-line preview", () => {
    expect(
      queuedTurnPreview({
        text: "  Check the tests\n\nand fix   the failure  ",
        attachments: [],
      }),
    ).toBe("Check the tests and fix the failure");
  });

  it("describes an attachment-only queued message", () => {
    expect(queuedTurnPreview({ text: "", attachments: [{}] })).toBe("1 attachment");
    expect(queuedTurnPreview({ text: "  ", attachments: [{}, {}] })).toBe("2 attachments");
  });

  it("uses a neutral fallback for an empty queued payload", () => {
    expect(queuedTurnPreview({ text: "", attachments: [] })).toBe("Queued message");
  });

  it("shows optimistic entries immediately without duplicating server acknowledgements", () => {
    const optimistic = {
      messageId: MessageId.make("queued-optimistic"),
      text: "Run next",
      attachments: [],
    };
    expect(
      reconcileQueuedTurnPreviews({
        serverQueuedTurns: [],
        optimisticQueuedTurns: [optimistic],
        hiddenMessageIds: new Set(),
        sentMessageIds: new Set(),
      }),
    ).toEqual([optimistic]);
    expect(
      reconcileQueuedTurnPreviews({
        serverQueuedTurns: [optimistic],
        optimisticQueuedTurns: [optimistic],
        hiddenMessageIds: new Set(),
        sentMessageIds: new Set(),
      }),
    ).toEqual([optimistic]);
  });

  it("hides optimistic cancellations and queued ids already sent to the timeline", () => {
    const cancelled = {
      messageId: MessageId.make("queued-cancelled"),
      text: "Cancel me",
      attachments: [],
    };
    const dispatched = {
      messageId: MessageId.make("queued-dispatched"),
      text: "Already sent",
      attachments: [],
    };
    expect(
      reconcileQueuedTurnPreviews({
        serverQueuedTurns: [cancelled, dispatched],
        optimisticQueuedTurns: [],
        hiddenMessageIds: new Set([cancelled.messageId]),
        sentMessageIds: new Set([dispatched.messageId]),
      }),
    ).toEqual([]);
  });
});
