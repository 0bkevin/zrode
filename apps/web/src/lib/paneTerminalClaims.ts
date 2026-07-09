/**
 * Cross-window ownership claims for panes hosted in other windows.
 *
 * Two kinds of resources need an owner across windows:
 *
 * - Server terminal sessions: any window's drawer reconciliation adopts every
 *   session it doesn't already account for, so a moved terminal would render
 *   the same PTY in two windows (resize fights, and a close from one window
 *   kills the other's terminal).
 * - Preview tabs: every window's ElectronBrowserHost mounts a <webview> per
 *   live session, so two windows would fight over registering the same tabId
 *   with the desktop preview manager.
 *
 * Every window claims the terminal ids and preview tab ids it hosts over a
 * BroadcastChannel and re-broadcasts on a heartbeat; other windows exclude
 * claimed ids and drop claims whose heartbeats stop, so a crashed window
 * releases its resources automatically. A BroadcastChannel object does not
 * receive messages it posts itself, but other BroadcastChannel objects in the
 * same window can receive those messages. Locally-originated claim ids are
 * ignored by the listener side; this window's own claims are mirrored in a
 * local registry for components that need "what does this window host"
 * (popout webview hosting).
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

const CHANNEL_NAME = "zrode:pane-claims:v1";
const HEARTBEAT_MS = 5_000;
const CLAIM_TTL_MS = 3 * HEARTBEAT_MS;

export interface PaneClaimResources {
  terminalIds: readonly string[];
  previewTabIds: readonly string[];
}

type ClaimMessage =
  | {
      type: "claim";
      claimId: string;
      threadKey: string;
      terminalIds: readonly string[];
      previewTabIds: readonly string[];
    }
  | { type: "release"; claimId: string }
  | { type: "query" };

interface ClaimEntry {
  threadKey: string;
  terminalIds: readonly string[];
  previewTabIds: readonly string[];
  expiresAt: number;
}

function createChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") {
    return null;
  }
  return new BroadcastChannel(CHANNEL_NAME);
}

function sanitizeIds(ids: unknown): readonly string[] {
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

const EMPTY_CLAIMED_IDS: ReadonlySet<string> = new Set();

/*
 * Listener side: tracks live claims from other windows.
 */
const claimsByClaimId = new Map<string, ClaimEntry>();
const listeners = new Set<() => void>();
const claimedTerminalIdsByThreadKey = new Map<string, ReadonlySet<string>>();
let claimedPreviewTabIdsCache: ReadonlySet<string> | null = null;
let listenChannel: BroadcastChannel | null = null;
let listenSweepInterval: ReturnType<typeof setInterval> | null = null;
let lastSweepAt: number | null = null;
// Append-only in production: a claim can still be delivered after its
// publisher disposes, and it must still be recognized as locally originated.
const locallyOriginatedClaimIds = new Set<string>();
// Tabs a move-to-window flow has handed off but whose destination window
// hasn't broadcast its claim yet (it is still booting). Treated as claimed so
// the origin window neither re-adopts nor closes the tab in the gap.
const detachingPreviewTabExpiries = new Map<string, number>();
const DETACHING_GRACE_MS = CLAIM_TTL_MS;

function idListsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function notify(): void {
  claimedTerminalIdsByThreadKey.clear();
  claimedPreviewTabIdsCache = null;
  for (const listener of listeners) {
    listener();
  }
}

function sweepExpiredClaims(): void {
  const now = Date.now();
  // After a system sleep every claim looks expired even though the owning
  // windows just haven't run yet. Grant one grace heartbeat instead of
  // dropping live claims and bouncing their resources between windows.
  if (lastSweepAt !== null && now - lastSweepAt > CLAIM_TTL_MS) {
    lastSweepAt = now;
    for (const entry of claimsByClaimId.values()) {
      entry.expiresAt = Math.max(entry.expiresAt, now + CLAIM_TTL_MS);
    }
    return;
  }
  lastSweepAt = now;
  let changed = false;
  for (const [claimId, entry] of claimsByClaimId) {
    if (entry.expiresAt <= now) {
      claimsByClaimId.delete(claimId);
      changed = true;
    }
  }
  for (const [tabId, expiresAt] of detachingPreviewTabExpiries) {
    if (expiresAt <= now) {
      detachingPreviewTabExpiries.delete(tabId);
      changed = true;
    }
  }
  if (changed) {
    notify();
  }
}

function clearDetachingMarks(previewTabIds: readonly string[]): boolean {
  let cleared = false;
  for (const tabId of previewTabIds) {
    if (detachingPreviewTabExpiries.delete(tabId)) {
      cleared = true;
    }
  }
  return cleared;
}

function handleListenMessage(event: MessageEvent): void {
  const message = event.data as ClaimMessage | null;
  if (!message || typeof message !== "object") {
    return;
  }
  if (
    (message.type === "claim" || message.type === "release") &&
    typeof message.claimId === "string" &&
    locallyOriginatedClaimIds.has(message.claimId)
  ) {
    return;
  }
  if (message.type === "claim" && typeof message.claimId === "string") {
    const entry: ClaimEntry = {
      threadKey: typeof message.threadKey === "string" ? message.threadKey : "",
      terminalIds: sanitizeIds(message.terminalIds),
      previewTabIds: sanitizeIds(message.previewTabIds),
      expiresAt: Date.now() + CLAIM_TTL_MS,
    };
    const detachingCleared = clearDetachingMarks(entry.previewTabIds);
    const previous = claimsByClaimId.get(message.claimId);
    claimsByClaimId.set(message.claimId, entry);
    // Heartbeats mostly repeat the same payload; refreshing expiresAt must
    // not re-render every consumer (webview hosts resubscribe on render).
    if (
      previous !== undefined &&
      !detachingCleared &&
      previous.threadKey === entry.threadKey &&
      idListsEqual(previous.terminalIds, entry.terminalIds) &&
      idListsEqual(previous.previewTabIds, entry.previewTabIds)
    ) {
      return;
    }
    notify();
    return;
  }
  if (message.type === "release" && typeof message.claimId === "string") {
    if (claimsByClaimId.delete(message.claimId)) {
      notify();
    }
  }
}

/**
 * Mark a preview tab as mid-handoff to a new window: it counts as
 * remote-claimed until the destination window's claim arrives (or a grace
 * period elapses because the window never came up).
 */
export function markPreviewTabDetaching(tabId: string): void {
  ensureListening();
  detachingPreviewTabExpiries.set(tabId, Date.now() + DETACHING_GRACE_MS);
  notify();
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
  listenSweepInterval = setInterval(sweepExpiredClaims, HEARTBEAT_MS);
}

function subscribe(listener: () => void): () => void {
  ensureListening();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function claimedTerminalIdsSnapshot(threadKey: string): ReadonlySet<string> {
  const cached = claimedTerminalIdsByThreadKey.get(threadKey);
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
  claimedTerminalIdsByThreadKey.set(threadKey, snapshot);
  return snapshot;
}

// Preview tab ids are globally unique, so their claim set is not per-thread.
// Tabs mid-handoff (marked detaching) count as claimed.
function claimedPreviewTabIdsSnapshot(): ReadonlySet<string> {
  if (claimedPreviewTabIdsCache) {
    return claimedPreviewTabIdsCache;
  }
  let ids: Set<string> | null = null;
  for (const entry of claimsByClaimId.values()) {
    for (const tabId of entry.previewTabIds) {
      (ids ??= new Set()).add(tabId);
    }
  }
  for (const tabId of detachingPreviewTabExpiries.keys()) {
    (ids ??= new Set()).add(tabId);
  }
  claimedPreviewTabIdsCache = ids ?? EMPTY_CLAIMED_IDS;
  return claimedPreviewTabIdsCache;
}

/** Terminal ids for this thread currently hosted by another window. */
export function useClaimedTerminalIds(ref: ScopedThreadRef): ReadonlySet<string> {
  const threadKey = scopedThreadKey(ref);
  return useSyncExternalStore(
    subscribe,
    () => claimedTerminalIdsSnapshot(threadKey),
    () => EMPTY_CLAIMED_IDS,
  );
}

/** Preview tab ids currently hosted by another window (all threads). */
export function useClaimedPreviewTabIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, claimedPreviewTabIdsSnapshot, () => EMPTY_CLAIMED_IDS);
}

/** Non-reactive read of the preview tab ids hosted by other windows. */
export function readClaimedPreviewTabIds(): ReadonlySet<string> {
  ensureListening();
  return claimedPreviewTabIdsSnapshot();
}

/*
 * Local mirror: the preview tab ids THIS window has claimed, aggregated over
 * all publishers in the window. The listener side ignores locally-originated
 * BroadcastChannel messages, so components that host what this window owns
 * read this instead.
 */
const localPreviewTabIdsByClaimId = new Map<string, readonly string[]>();
const localListeners = new Set<() => void>();
let localPreviewTabIdsCache: ReadonlySet<string> | null = null;

function notifyLocal(): void {
  localPreviewTabIdsCache = null;
  for (const listener of localListeners) {
    listener();
  }
}

function localPreviewTabIdsSnapshot(): ReadonlySet<string> {
  if (localPreviewTabIdsCache) {
    return localPreviewTabIdsCache;
  }
  let ids: Set<string> | null = null;
  for (const tabIds of localPreviewTabIdsByClaimId.values()) {
    for (const tabId of tabIds) {
      (ids ??= new Set()).add(tabId);
    }
  }
  localPreviewTabIdsCache = ids ?? EMPTY_CLAIMED_IDS;
  return localPreviewTabIdsCache;
}

function subscribeLocal(listener: () => void): () => void {
  localListeners.add(listener);
  return () => {
    localListeners.delete(listener);
  };
}

/** Preview tab ids claimed by THIS window. */
export function useLocalPreviewTabClaims(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeLocal, localPreviewTabIdsSnapshot, () => EMPTY_CLAIMED_IDS);
}

/** Internal/test-only read of the preview tab ids claimed by THIS window. */
export function __readLocalPreviewTabIdsForTests(): ReadonlySet<string> {
  return localPreviewTabIdsSnapshot();
}

/** Internal/test-only reset for module-level BroadcastChannel claim state. */
export function __resetPaneClaimsForTest(): void {
  claimsByClaimId.clear();
  listeners.clear();
  claimedTerminalIdsByThreadKey.clear();
  claimedPreviewTabIdsCache = null;
  if (listenChannel !== null) {
    listenChannel.removeEventListener("message", handleListenMessage);
    listenChannel.close();
    listenChannel = null;
  }
  if (listenSweepInterval !== null) {
    clearInterval(listenSweepInterval);
    listenSweepInterval = null;
  }
  lastSweepAt = null;
  detachingPreviewTabExpiries.clear();
  locallyOriginatedClaimIds.clear();
  localPreviewTabIdsByClaimId.clear();
  localListeners.clear();
  localPreviewTabIdsCache = null;
}

/*
 * Publisher side: claim the resources this window hosts for a thread.
 */
interface PaneClaimPublisher {
  setResources: (resources: PaneClaimResources) => void;
  dispose: () => void;
}

export function createPaneClaimPublisher(threadKey: string): PaneClaimPublisher {
  const channel = createChannel();
  if (channel === null) {
    return { setResources: () => undefined, dispose: () => undefined };
  }
  // Uniqueness only (no security property): distinguishes publishers across
  // windows and across remounts within a window.
  const claimId = `claim-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  locallyOriginatedClaimIds.add(claimId);
  ensureListening();
  let terminalIds: readonly string[] = [];
  let previewTabIds: readonly string[] = [];
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
  const postClaim = () => post({ type: "claim", claimId, threadKey, terminalIds, previewTabIds });
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
  const canUsePagehide =
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function" &&
    typeof window.removeEventListener === "function";
  if (canUsePagehide) {
    window.addEventListener("pagehide", release);
  }

  return {
    setResources: (resources) => {
      if (disposed) {
        return;
      }
      terminalIds = resources.terminalIds;
      previewTabIds = resources.previewTabIds;
      localPreviewTabIdsByClaimId.set(claimId, previewTabIds);
      notifyLocal();
      postClaim();
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      clearInterval(heartbeat);
      if (canUsePagehide) {
        window.removeEventListener("pagehide", release);
      }
      channel.removeEventListener("message", handleMessage);
      release();
      channel.close();
      if (localPreviewTabIdsByClaimId.delete(claimId)) {
        notifyLocal();
      }
    },
  };
}

/** Publish (and keep updated) this window's pane claims for a thread. */
export function usePaneClaimPublisher(
  ref: ScopedThreadRef | null,
  resources: PaneClaimResources,
): void {
  const threadKey = ref === null ? null : scopedThreadKey(ref);
  const publisherRef = useRef<PaneClaimPublisher | null>(null);

  useEffect(() => {
    if (threadKey === null) {
      return;
    }
    const publisher = createPaneClaimPublisher(threadKey);
    publisherRef.current = publisher;
    return () => {
      publisherRef.current = null;
      publisher.dispose();
    };
  }, [threadKey]);

  const terminalIdsKey = resources.terminalIds.join("\n");
  const previewTabIdsKey = resources.previewTabIds.join("\n");
  useEffect(() => {
    publisherRef.current?.setResources({
      terminalIds: terminalIdsKey.length === 0 ? [] : terminalIdsKey.split("\n"),
      previewTabIds: previewTabIdsKey.length === 0 ? [] : previewTabIdsKey.split("\n"),
    });
  }, [previewTabIdsKey, terminalIdsKey, threadKey]);
}
