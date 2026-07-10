import { create } from "zustand";

interface NotificationDismissalStore {
  readonly threadSessionErrorByThreadKey: Record<string, string>;
  readonly providerStatusByInstanceId: Record<string, string>;
  readonly dismissThreadSessionError: (threadKey: string, errorSignature: string) => void;
  readonly clearThreadSessionErrorDismissal: (threadKey: string) => void;
  readonly dismissProviderStatus: (instanceId: string, bannerKey: string) => void;
  readonly clearProviderStatusDismissal: (instanceId: string) => void;
}

function withoutKey(record: Record<string, string>, key: string): Record<string, string> {
  if (!(key in record)) {
    return record;
  }
  const { [key]: _removed, ...rest } = record;
  return rest;
}

/**
 * Notification dismissals are view state, but they must outlive a mounted thread view.
 * Keeping them in an app-level store prevents route changes from resurrecting the same
 * notification while still allowing a new error signature or provider status to appear.
 */
export const useNotificationDismissalStore = create<NotificationDismissalStore>((set) => ({
  threadSessionErrorByThreadKey: {},
  providerStatusByInstanceId: {},
  dismissThreadSessionError: (threadKey, errorSignature) =>
    set((state) =>
      state.threadSessionErrorByThreadKey[threadKey] === errorSignature
        ? state
        : {
            threadSessionErrorByThreadKey: {
              ...state.threadSessionErrorByThreadKey,
              [threadKey]: errorSignature,
            },
          },
    ),
  clearThreadSessionErrorDismissal: (threadKey) =>
    set((state) => {
      const next = withoutKey(state.threadSessionErrorByThreadKey, threadKey);
      return next === state.threadSessionErrorByThreadKey
        ? state
        : { threadSessionErrorByThreadKey: next };
    }),
  dismissProviderStatus: (instanceId, bannerKey) =>
    set((state) =>
      state.providerStatusByInstanceId[instanceId] === bannerKey
        ? state
        : {
            providerStatusByInstanceId: {
              ...state.providerStatusByInstanceId,
              [instanceId]: bannerKey,
            },
          },
    ),
  clearProviderStatusDismissal: (instanceId) =>
    set((state) => {
      const next = withoutKey(state.providerStatusByInstanceId, instanceId);
      return next === state.providerStatusByInstanceId
        ? state
        : { providerStatusByInstanceId: next };
    }),
}));
