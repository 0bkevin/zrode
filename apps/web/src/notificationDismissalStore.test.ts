import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useNotificationDismissalStore } from "./notificationDismissalStore";

describe("notificationDismissalStore", () => {
  beforeEach(() => {
    useNotificationDismissalStore.setState({
      threadSessionErrorByThreadKey: {},
      providerStatusByInstanceId: {},
    });
  });

  it("retains thread error dismissals outside a mounted thread view", () => {
    const firstOccurrence = "2026-01-01T00:00:00.000Z::Provider request failed.";
    useNotificationDismissalStore
      .getState()
      .dismissThreadSessionError("local::thread-1", firstOccurrence);

    expect(
      useNotificationDismissalStore.getState().threadSessionErrorByThreadKey["local::thread-1"],
    ).toBe(firstOccurrence);

    useNotificationDismissalStore
      .getState()
      .dismissThreadSessionError(
        "local::thread-1",
        "2026-01-01T00:01:00.000Z::Provider request failed.",
      );

    expect(
      useNotificationDismissalStore.getState().threadSessionErrorByThreadKey["local::thread-1"],
    ).not.toBe(firstOccurrence);
  });

  it("clears thread and provider dismissals when their source recovers", () => {
    const store = useNotificationDismissalStore.getState();
    store.dismissThreadSessionError("local::thread-1", "error-signature");
    store.dismissProviderStatus("opencode", "provider-banner");

    useNotificationDismissalStore.getState().clearThreadSessionErrorDismissal("local::thread-1");
    useNotificationDismissalStore.getState().clearProviderStatusDismissal("opencode");

    expect(useNotificationDismissalStore.getState().threadSessionErrorByThreadKey).toEqual({});
    expect(useNotificationDismissalStore.getState().providerStatusByInstanceId).toEqual({});
  });
});
