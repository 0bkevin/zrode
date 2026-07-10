import { WorkerPoolContext } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { useCallback, useEffect, useState } from "react";

import { useTheme } from "~/hooks/useTheme";

import {
  hasWorkspaceEditorRenderOptions,
  type WorkspaceEditorResolvedTheme,
  workspaceEditorRenderOptions,
} from "./workspaceEditorPresentation";
import {
  createWorkspaceEditorWorkerPoolLifecycle,
  resolveWorkspaceEditorWorkerPoolSize,
  type WorkspaceEditorWorkerPoolProviderProps,
} from "./workspaceEditorWorkerPoolLifecycle";

function createWorkspaceEditorWorkerPool(theme: WorkspaceEditorResolvedTheme): WorkerPoolManager {
  const hardwareConcurrency =
    typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency;

  return new WorkerPoolManager(
    {
      workerFactory: () => new DiffsWorker(),
      poolSize: resolveWorkspaceEditorWorkerPoolSize(hardwareConcurrency),
      totalASTLRUCacheSize: 120,
    },
    workspaceEditorRenderOptions(theme),
  );
}

const workspaceEditorWorkerPoolLifecycle = createWorkspaceEditorWorkerPoolLifecycle({
  createPool: createWorkspaceEditorWorkerPool,
  getPageLifecycleTarget: () => (typeof window === "undefined" ? undefined : window),
});

export function WorkspaceEditorWorkerPoolProvider({
  children,
}: WorkspaceEditorWorkerPoolProviderProps) {
  const { resolvedTheme } = useTheme();
  const getWorkerPool = useCallback(
    () => workspaceEditorWorkerPoolLifecycle.getOrCreate(resolvedTheme),
    [resolvedTheme],
  );
  const [workerPool, setWorkerPool] = useState(getWorkerPool);

  useEffect(() => {
    const updateWorkerPool = () => {
      setWorkerPool(getWorkerPool());
    };
    const unsubscribe = workspaceEditorWorkerPoolLifecycle.subscribe(updateWorkerPool);
    updateWorkerPool();
    return unsubscribe;
  }, [getWorkerPool]);

  useEffect(() => {
    if (workerPool === undefined) return;
    const current = workerPool.getDiffRenderOptions();
    if (hasWorkspaceEditorRenderOptions(current, resolvedTheme)) return;

    void workerPool.setRenderOptions(workspaceEditorRenderOptions(resolvedTheme)).catch((cause) => {
      console.error("Failed to update the workspace editor syntax-highlighting theme.", cause);
    });
  }, [resolvedTheme, workerPool]);

  return <WorkerPoolContext.Provider value={workerPool}>{children}</WorkerPoolContext.Provider>;
}
