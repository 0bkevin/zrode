import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopLocalBootstrapStore } from "./useDesktopLocalBootstraps";

const bootstrap = (label: string): DesktopEnvironmentBootstrap => ({
  id: "wsl:ubuntu",
  label,
  runningDistro: "Ubuntu",
  httpBaseUrl: "http://127.0.0.1:3774/",
  wsBaseUrl: "ws://127.0.0.1:3774/",
  bootstrapToken: "token",
});

describe("desktop local bootstrap store", () => {
  it("shares one poller and only notifies when topology changes", () => {
    let current: ReadonlyArray<DesktopEnvironmentBootstrap> = [bootstrap("WSL")];
    const polls: Array<() => void> = [];
    const cancel = vi.fn();
    const schedule = vi.fn((refresh: () => void) => {
      polls.push(refresh);
      return cancel;
    });
    const store = createDesktopLocalBootstrapStore({ read: () => current, schedule });
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = store.subscribe(first);
    const unsubscribeSecond = store.subscribe(second);
    expect(schedule).toHaveBeenCalledOnce();

    polls[0]?.();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    current = [bootstrap("WSL (Ubuntu)")];
    polls[0]?.();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toBe(current);

    unsubscribeFirst();
    expect(cancel).not.toHaveBeenCalled();
    unsubscribeSecond();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
