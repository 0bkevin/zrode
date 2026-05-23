import { scopedThreadKey } from "@zrode/client-runtime";
import type { ScopedThreadRef } from "@zrode/contracts";
import { useEffect, useRef } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import { readEnvironmentApi } from "../environmentApi";
import { resolveDisposableThreadRefToDispose } from "../lib/disposableThread";
import { newCommandId } from "../lib/utils";
import { selectThreadByRef, useStore } from "../store";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";

export function useDisposableThreadLifecycle(activeThreadRef: ScopedThreadRef | null): void {
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearTerminalState = useTerminalStateStore((store) => store.clearTerminalState);
  const temporaryThreadKeys = useTemporaryThreadStore((store) => store.temporaryThreadKeys);
  const clearTemporaryThread = useTemporaryThreadStore((store) => store.clearTemporaryThread);
  const initialDraftThread =
    activeThreadRef !== null
      ? useComposerDraftStore.getState().getDraftThreadByRef(activeThreadRef)
      : undefined;
  const previousThreadStateRef = useRef<{
    threadRef: ScopedThreadRef | null;
    wasTemporary: boolean;
  }>({
    threadRef: activeThreadRef,
    wasTemporary:
      (activeThreadRef ? temporaryThreadKeys[scopedThreadKey(activeThreadRef)] === true : false) ||
      initialDraftThread?.isTemporary === true,
  });
  const disposingThreadKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const previousThreadState = previousThreadStateRef.current;
    const draftThreadsByThreadKey = useComposerDraftStore.getState().draftThreadsByThreadKey;
    previousThreadStateRef.current = {
      threadRef: activeThreadRef,
      wasTemporary: activeThreadRef
        ? temporaryThreadKeys[scopedThreadKey(activeThreadRef)] === true ||
          useComposerDraftStore.getState().getDraftThreadByRef(activeThreadRef)?.isTemporary ===
            true
        : false,
    };

    const disposableThreadRef = resolveDisposableThreadRefToDispose({
      previousThreadRef: previousThreadState.threadRef,
      nextThreadRef: activeThreadRef,
      previousThreadWasTemporary: previousThreadState.wasTemporary,
      draftThreadsByThreadKey,
    });
    if (!disposableThreadRef) {
      return;
    }

    const disposableThreadKey = scopedThreadKey(disposableThreadRef);
    if (disposingThreadKeysRef.current.has(disposableThreadKey)) {
      return;
    }

    disposingThreadKeysRef.current.add(disposableThreadKey);
    void (async () => {
      try {
        const api = readEnvironmentApi(disposableThreadRef.environmentId);
        const serverThread = selectThreadByRef(useStore.getState(), disposableThreadRef) ?? null;

        if (api) {
          if (serverThread?.session && serverThread.session.status !== "closed") {
            await api.orchestration
              .dispatchCommand({
                type: "thread.session.stop",
                commandId: newCommandId(),
                threadId: disposableThreadRef.threadId,
                createdAt: new Date().toISOString(),
              })
              .catch(() => undefined);
          }

          await api.terminal
            .close({ threadId: disposableThreadRef.threadId, deleteHistory: true })
            .catch(() => undefined);

          if (serverThread) {
            await api.orchestration
              .dispatchCommand({
                type: "thread.delete",
                commandId: newCommandId(),
                threadId: disposableThreadRef.threadId,
              })
              .catch(() => undefined);
          }
        }

        clearDraftThread(disposableThreadRef);
        clearTerminalState(disposableThreadRef);
        clearTemporaryThread(disposableThreadRef);
      } finally {
        disposingThreadKeysRef.current.delete(disposableThreadKey);
      }
    })();
  }, [
    activeThreadRef,
    clearDraftThread,
    clearTemporaryThread,
    clearTerminalState,
    temporaryThreadKeys,
  ]);
}
