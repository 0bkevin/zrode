import { scopedThreadKey } from "@zrode/client-runtime";
import type { ScopedThreadRef } from "@zrode/contracts";
import { create } from "zustand";

interface TemporaryThreadStoreState {
  temporaryThreadKeys: Record<string, true | undefined>;
  markTemporaryThread: (threadRef: ScopedThreadRef) => void;
  clearTemporaryThread: (threadRef: ScopedThreadRef) => void;
  isTemporaryThread: (threadRef: ScopedThreadRef | null | undefined) => boolean;
}

export const useTemporaryThreadStore = create<TemporaryThreadStoreState>((set, get) => ({
  temporaryThreadKeys: {},
  markTemporaryThread: (threadRef) => {
    if (threadRef.threadId.length === 0 || threadRef.environmentId.length === 0) return;
    const threadKey = scopedThreadKey(threadRef);
    set((state) => {
      if (state.temporaryThreadKeys[threadKey]) {
        return state;
      }
      return {
        temporaryThreadKeys: {
          ...state.temporaryThreadKeys,
          [threadKey]: true,
        },
      };
    });
  },
  clearTemporaryThread: (threadRef) => {
    if (threadRef.threadId.length === 0 || threadRef.environmentId.length === 0) return;
    const threadKey = scopedThreadKey(threadRef);
    set((state) => {
      if (!state.temporaryThreadKeys[threadKey]) {
        return state;
      }
      const nextTemporaryThreadKeys = { ...state.temporaryThreadKeys };
      delete nextTemporaryThreadKeys[threadKey];
      return { temporaryThreadKeys: nextTemporaryThreadKeys };
    });
  },
  isTemporaryThread: (threadRef) => {
    if (!threadRef) return false;
    return get().temporaryThreadKeys[scopedThreadKey(threadRef)] === true;
  },
}));
