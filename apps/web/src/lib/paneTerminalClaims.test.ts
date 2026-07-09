import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __readLocalPreviewTabIdsForTests,
  __resetPaneClaimsForTest,
  createPaneClaimPublisher,
  markPreviewTabDetaching,
  readClaimedPreviewTabIds,
} from "./paneTerminalClaims";

const CHANNEL_NAME = "zrode:pane-claims:v1";

class TestBroadcastChannel {
  private static readonly channelsByName = new Map<string, Set<TestBroadcastChannel>>();

  onmessage: ((this: BroadcastChannel, event: MessageEvent) => unknown) | null = null;
  private readonly listeners = new Set<EventListenerOrEventListenerObject>();
  private closed = false;

  constructor(readonly name: string) {
    const channels = TestBroadcastChannel.channelsByName.get(name) ?? new Set();
    channels.add(this);
    TestBroadcastChannel.channelsByName.set(name, channels);
  }

  static reset(): void {
    TestBroadcastChannel.channelsByName.clear();
  }

  postMessage(message: unknown): void {
    if (this.closed) {
      return;
    }
    const targets = [...(TestBroadcastChannel.channelsByName.get(this.name) ?? [])].filter(
      (target) => target !== this && !target.closed,
    );
    for (const target of targets) {
      queueMicrotask(() => {
        if (!target.closed) {
          target.dispatchMessage(message);
        }
      });
    }
  }

  close(): void {
    this.closed = true;
    const channels = TestBroadcastChannel.channelsByName.get(this.name);
    channels?.delete(this);
    if (channels?.size === 0) {
      TestBroadcastChannel.channelsByName.delete(this.name);
    }
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type === "message" && listener !== null) {
      this.listeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type === "message" && listener !== null) {
      this.listeners.delete(listener);
    }
  }

  private dispatchMessage(message: unknown): void {
    const event = { data: message } as MessageEvent;
    this.onmessage?.call(this as unknown as BroadcastChannel, event);
    for (const listener of this.listeners) {
      if (typeof listener === "function") {
        listener.call(this, event);
      } else {
        listener.handleEvent(event);
      }
    }
  }
}

async function flushBroadcastMessages(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function postBroadcast(channel: BroadcastChannel, message: unknown): void {
  // BroadcastChannel.postMessage has no targetOrigin; this rule is for window.postMessage.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  channel.postMessage(message);
}

describe("paneTerminalClaims", () => {
  beforeEach(() => {
    TestBroadcastChannel.reset();
    vi.stubGlobal("BroadcastChannel", TestBroadcastChannel);
    __resetPaneClaimsForTest();
  });

  afterEach(() => {
    __resetPaneClaimsForTest();
    TestBroadcastChannel.reset();
    vi.unstubAllGlobals();
  });

  it("keeps a local publisher's preview tab local instead of remote-claimed", async () => {
    const publisher = createPaneClaimPublisher("thread-local");
    try {
      publisher.setResources({ terminalIds: [], previewTabIds: ["tab-local"] });
      await flushBroadcastMessages();

      expect([...__readLocalPreviewTabIdsForTests()]).toEqual(["tab-local"]);
      expect(readClaimedPreviewTabIds().has("tab-local")).toBe(false);
    } finally {
      publisher.dispose();
    }
  });

  it("tracks and releases foreign BroadcastChannel claims", async () => {
    readClaimedPreviewTabIds();
    const foreign = new BroadcastChannel(CHANNEL_NAME);
    try {
      postBroadcast(foreign, {
        type: "claim",
        claimId: "foreign-claim",
        threadKey: "thread-foreign",
        terminalIds: [],
        previewTabIds: ["tab-foreign"],
      });
      await flushBroadcastMessages();

      expect([...readClaimedPreviewTabIds()]).toEqual(["tab-foreign"]);

      postBroadcast(foreign, { type: "release", claimId: "foreign-claim" });
      await flushBroadcastMessages();

      expect([...readClaimedPreviewTabIds()]).toEqual([]);
    } finally {
      foreign.close();
    }
  });

  it("keeps local preview ownership stable across claim-filter reconciliation", async () => {
    const publisher = createPaneClaimPublisher("thread-stable");
    const tabs = ["tab-stable"];
    try {
      for (let iteration = 0; iteration < 6; iteration += 1) {
        const claimed = readClaimedPreviewTabIds();
        publisher.setResources({
          terminalIds: [],
          previewTabIds: tabs.filter((tabId) => !claimed.has(tabId)),
        });
        await flushBroadcastMessages();

        expect([...__readLocalPreviewTabIdsForTests()]).toEqual(tabs);
        expect(readClaimedPreviewTabIds().has("tab-stable")).toBe(false);
      }
    } finally {
      publisher.dispose();
    }
  });

  it("only clears detaching marks when a foreign claim arrives", async () => {
    markPreviewTabDetaching("tab-detaching");
    expect(readClaimedPreviewTabIds().has("tab-detaching")).toBe(true);

    const publisher = createPaneClaimPublisher("thread-detaching");
    const foreign = new BroadcastChannel(CHANNEL_NAME);
    try {
      publisher.setResources({ terminalIds: [], previewTabIds: ["tab-detaching"] });
      await flushBroadcastMessages();
      expect(readClaimedPreviewTabIds().has("tab-detaching")).toBe(true);

      postBroadcast(foreign, {
        type: "claim",
        claimId: "foreign-detaching-claim",
        threadKey: "thread-detaching",
        terminalIds: [],
        previewTabIds: ["tab-detaching"],
      });
      await flushBroadcastMessages();
      expect(readClaimedPreviewTabIds().has("tab-detaching")).toBe(true);

      postBroadcast(foreign, { type: "release", claimId: "foreign-detaching-claim" });
      await flushBroadcastMessages();
      expect(readClaimedPreviewTabIds().has("tab-detaching")).toBe(false);
    } finally {
      publisher.dispose();
      foreign.close();
    }
  });
});
