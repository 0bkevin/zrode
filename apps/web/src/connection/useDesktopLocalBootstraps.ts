import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;

interface DesktopLocalBootstrapStore {
  readonly getSnapshot: () => ReadonlyArray<DesktopEnvironmentBootstrap>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refresh: () => void;
}

function bootstrapsEqual(
  left: ReadonlyArray<DesktopEnvironmentBootstrap>,
  right: ReadonlyArray<DesktopEnvironmentBootstrap>,
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        entry.id === candidate.id &&
        entry.label === candidate.label &&
        entry.runningDistro === candidate.runningDistro &&
        entry.httpBaseUrl === candidate.httpBaseUrl &&
        entry.wsBaseUrl === candidate.wsBaseUrl &&
        entry.bootstrapToken === candidate.bootstrapToken
      );
    })
  );
}

export function createDesktopLocalBootstrapStore(input: {
  readonly read: () => ReadonlyArray<DesktopEnvironmentBootstrap>;
  readonly schedule?: (refresh: () => void) => () => void;
}): DesktopLocalBootstrapStore {
  let snapshot = input.read();
  const listeners = new Set<() => void>();
  let cancelPolling: (() => void) | null = null;
  const schedule =
    input.schedule ??
    ((refresh: () => void) => {
      const interval = window.setInterval(refresh, DESKTOP_LOCAL_BOOTSTRAP_POLL_MS);
      return () => window.clearInterval(interval);
    });

  const refresh = () => {
    const next = input.read();
    if (bootstrapsEqual(snapshot, next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,
    refresh,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        refresh();
        cancelPolling = schedule(refresh);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          cancelPolling?.();
          cancelPolling = null;
        }
      };
    },
  };
}

const desktopLocalBootstrapStore = createDesktopLocalBootstrapStore({
  read: () => (typeof window === "undefined" ? [] : readDesktopSecondaryBootstraps()),
  schedule: (refresh) => {
    const subscribe = window.desktopBridge?.onLocalEnvironmentBootstraps;
    if (subscribe) return subscribe(refresh);
    const interval = window.setInterval(refresh, DESKTOP_LOCAL_BOOTSTRAP_POLL_MS);
    return () => window.clearInterval(interval);
  },
});

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). Desktop builds subscribe to the preload topology cache; browser and
 * older bridge implementations retain an interval fallback. Failed reads retain
 * the latest successful snapshot, while a successful empty read clears it.
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useSyncExternalStore(
    desktopLocalBootstrapStore.subscribe,
    desktopLocalBootstrapStore.getSnapshot,
    desktopLocalBootstrapStore.getSnapshot,
  );
}
