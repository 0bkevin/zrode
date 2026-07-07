/**
 * Cross-window ownership claims for terminals hosted in other windows.
 *
 * Server terminal sessions have no owner: any window's drawer reconciliation
 * adopts every session it doesn't already account for. With popout pane
 * windows that means the same PTY can end up rendered in two windows (resize
 * fights, and a close from one window kills the other's terminal).
 *
 * Every window claims the terminal ids it hosts over a BroadcastChannel and
 * re-broadcasts on a heartbeat; other windows exclude claimed ids from drawer
 * adoption and drop claims whose heartbeats stop, so a crashed window
 * releases its terminals automatically. BroadcastChannel never delivers to
 * the posting window, so a window only ever sees other windows' claims.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

const CHANNEL_NAME = "zrode:pane-terminal-claims:v1";
const HEARTBEAT_MS = 5_000;
const CLAIM_TTL_MS = 3 * HEARTBEAT_MS;

type ClaimMessage =
  | { type: "claim"; claimId: string; threadKey: string; terminalIds: readonly string[] }
  | { type: "release"; claimId: string }
  | { type: "query" };

interface ClaimEntry {
  threadKey: string;
  terminalIds: readonly string[];
  expiresAt: number;
}

function createChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") {
    return null;
  }
  return new BroadcastChannel(CHANNEL_NAME);
}

const EMPTY_CLAIMED_IDS: ReadonlySet<string> = new Set();

/*
 * Listener side: tracks live claims from other windows.
 */
const claimsByClaimId = new Map<string, ClaimEntry>();
const listeners = new Set<() => void>();
const claimedIdsByThreadKey = new Map<string, ReadonlySet<string>>();
let listenChannel: BroadcastChannel | null = null;

function notify(): void {
  claimedIdsByThreadKey.clear();
  for (const listener of listeners) {
    listener();
  }
}

function sweepExpiredClaims(): void {
  const now = Date.now();
  let changed = false;
  for (const [claimId, entry] of claimsByClaimId) {
    if (entry.expiresAt <= now) {
      claimsByClaimId.delete(claimId);
      changed = true;
    }
  }
  if (changed) {
    notify();
  }
}

function handleListenMessage(event: MessageEvent): void {
  const message = event.data as ClaimMessage | null;
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "claim" && typeof message.claimId === "string") {
    claimsByClaimId.set(message.claimId, {
      threadKey: typeof message.threadKey === "string" ? message.threadKey : "",
      terminalIds: Array.isArray(message.terminalIds)
        ? message.terminalIds.filter((id): id is string => typeof id === "string")
        : [],
      expiresAt: Date.now() + CLAIM_TTL_MS,
    });
    notify();
    return;
  }
  if (message.type === "release" && typeof message.claimId === "string") {
    if (claimsByClaimId.delete(message.claimId)) {
      notify();
    }
  }
}

function ensureListening(): void {
  if (listenChannel !== null) {
    return;
  }
  listenChannel = createChannel();
  if (listenChannel === null) {
    return;
  }
  listenChannel.addEventListener("message", handleListenMessage);
  // Collect claims from windows that were already open when this one booted.
  // (BroadcastChannel.postMessage has no targetOrigin — the rule below is for
  // window.postMessage.)
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  listenChannel.postMessage({ type: "query" } satisfies ClaimMessage);
  setInterval(sweepExpiredClaims, HEARTBEAT_MS);
}

function subscribe(listener: () => void): () => void {
  ensureListening();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function claimedIdsSnapshot(threadKey: string): ReadonlySet<string> {
  const cached = claimedIdsByThreadKey.get(threadKey);
  if (cached) {
    return cached;
  }
  let ids: Set<string> | null = null;
  for (const entry of claimsByClaimId.values()) {
    if (entry.threadKey !== threadKey) {
      continue;
    }
    for (const terminalId of entry.terminalIds) {
      (ids ??= new Set()).add(terminalId);
    }
  }
  const snapshot: ReadonlySet<string> = ids ?? EMPTY_CLAIMED_IDS;
  claimedIdsByThreadKey.set(threadKey, snapshot);
  return snapshot;
}

/** Terminal ids for this thread currently hosted by another window. */
export function useClaimedTerminalIds(ref: ScopedThreadRef): ReadonlySet<string> {
  const threadKey = scopedThreadKey(ref);
  return useSyncExternalStore(
    subscribe,
    () => claimedIdsSnapshot(threadKey),
    () => EMPTY_CLAIMED_IDS,
  );
}

/*
 * Publisher side: claim the terminal ids this window hosts for a thread.
 */
interface PaneTerminalClaimPublisher {
  setTerminalIds: (terminalIds: readonly string[]) => void;
  dispose: () => void;
}

export function createPaneTerminalClaimPublisher(threadKey: string): PaneTerminalClaimPublisher {
  const channel = createChannel();
  if (channel === null) {
    return { setTerminalIds: () => undefined, dispose: () => undefined };
  }
  // Uniqueness only (no security property): distinguishes publishers across
  // windows and across remounts within a window.
  const claimId = `claim-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  let terminalIds: readonly string[] = [];
  let disposed = false;

  const post = (message: ClaimMessage) => {
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      channel.postMessage(message);
    } catch {
      // Channel already closed (teardown race) — nothing to do.
    }
  };
  // Updating an existing claimId replaces the entry in listeners atomically,
  // so id changes never open a release→claim gap another window could adopt in.
  const postClaim = () => post({ type: "claim", claimId, threadKey, terminalIds });
  const release = () => post({ type: "release", claimId });

  const heartbeat = setInterval(postClaim, HEARTBEAT_MS);
  const handleMessage = (event: MessageEvent) => {
    const message = event.data as ClaimMessage | null;
    if (message && typeof message === "object" && message.type === "query") {
      postClaim();
    }
  };
  channel.addEventListener("message", handleMessage);
  // pagehide fires reliably on window close in Chromium (unlike unload); the
  // release message is posted before the document dies.
  window.addEventListener("pagehide", release);

  return {
    setTerminalIds: (nextTerminalIds) => {
      if (disposed) {
        return;
      }
      terminalIds = nextTerminalIds;
      postClaim();
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      clearInterval(heartbeat);
      window.removeEventListener("pagehide", release);
      channel.removeEventListener("message", handleMessage);
      release();
      channel.close();
    },
  };
}

/** Publish (and keep updated) this window's terminal claims for a thread. */
export function usePaneTerminalClaimPublisher(
  ref: ScopedThreadRef | null,
  terminalIds: readonly string[],
): void {
  const threadKey = ref === null ? null : scopedThreadKey(ref);
  const publisherRef = useRef<PaneTerminalClaimPublisher | null>(null);

  useEffect(() => {
    if (threadKey === null) {
      return;
    }
    const publisher = createPaneTerminalClaimPublisher(threadKey);
    publisherRef.current = publisher;
    return () => {
      publisherRef.current = null;
      publisher.dispose();
    };
  }, [threadKey]);

  const idsKey = terminalIds.join("\n");
  useEffect(() => {
    publisherRef.current?.setTerminalIds(idsKey.length === 0 ? [] : idsKey.split("\n"));
  }, [idsKey, threadKey]);
}
