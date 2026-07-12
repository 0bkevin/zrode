import type { ReactNode } from "react";

export const WORKSPACE_EDITOR_WORKER_POOL_MAX_SIZE = 2;

export function resolveWorkspaceEditorWorkerPoolSize(
  hardwareConcurrency: number | undefined,
): number {
  if (hardwareConcurrency === undefined || !Number.isFinite(hardwareConcurrency)) {
    return WORKSPACE_EDITOR_WORKER_POOL_MAX_SIZE;
  }

  return Math.min(
    WORKSPACE_EDITOR_WORKER_POOL_MAX_SIZE,
    Math.max(1, Math.floor(hardwareConcurrency)),
  );
}

export interface WorkspaceEditorPageLifecycleTarget {
  addEventListener(type: "pagehide" | "pageshow", listener: EventListener): void;
  removeEventListener(type: "pagehide" | "pageshow", listener: EventListener): void;
}

interface TerminableWorkerPool {
  terminate(): void;
}

interface WorkspaceEditorWorkerPoolLifecycleOptions<TPool extends TerminableWorkerPool, TTheme> {
  readonly createPool: (theme: TTheme) => TPool;
  readonly getPageLifecycleTarget: () => WorkspaceEditorPageLifecycleTarget | undefined;
}

export interface WorkspaceEditorWorkerPoolLifecycle<TPool, TTheme> {
  readonly getOrCreate: (theme: TTheme) => TPool | undefined;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

/**
 * Owns one lazy worker pool for the current JavaScript realm. A browser popout
 * evaluates this module in another realm and therefore receives another pool.
 * The pool is torn down on pagehide and recreated after a bfcache pageshow.
 */
export function createWorkspaceEditorWorkerPoolLifecycle<
  TPool extends TerminableWorkerPool,
  TTheme,
>({
  createPool,
  getPageLifecycleTarget,
}: WorkspaceEditorWorkerPoolLifecycleOptions<TPool, TTheme>): WorkspaceEditorWorkerPoolLifecycle<
  TPool,
  TTheme
> {
  let pool: TPool | undefined;
  let pageHidden = false;
  let lifecycleTarget: WorkspaceEditorPageLifecycleTarget | undefined;
  const subscribers = new Set<() => void>();

  const notifySubscribers = () => {
    for (const subscriber of subscribers) subscriber();
  };

  const terminatePool = () => {
    const current = pool;
    pool = undefined;
    current?.terminate();
  };

  const handlePageHide: EventListener = () => {
    pageHidden = true;
    terminatePool();
    notifySubscribers();
  };

  const handlePageShow: EventListener = () => {
    pageHidden = false;
    notifySubscribers();
  };

  const installPageLifecycle = () => {
    if (lifecycleTarget !== undefined) return;
    const target = getPageLifecycleTarget();
    if (target === undefined) return;
    lifecycleTarget = target;
    target.addEventListener("pagehide", handlePageHide);
    target.addEventListener("pageshow", handlePageShow);
  };

  return {
    getOrCreate(theme) {
      installPageLifecycle();
      if (lifecycleTarget === undefined || pageHidden) return undefined;
      pool ??= createPool(theme);
      return pool;
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    dispose() {
      terminatePool();
      if (lifecycleTarget !== undefined) {
        lifecycleTarget.removeEventListener("pagehide", handlePageHide);
        lifecycleTarget.removeEventListener("pageshow", handlePageShow);
        lifecycleTarget = undefined;
      }
      subscribers.clear();
    },
  };
}

export interface WorkspaceEditorWorkerPoolProviderProps {
  readonly children?: ReactNode;
}
