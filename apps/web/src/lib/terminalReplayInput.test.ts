import { describe, expect, it, vi } from "vite-plus/test";

import {
  createTerminalReplayInputGuard,
  subscribeToTerminalUserInput,
} from "./terminalReplayInput";

describe("terminal replay input guard", () => {
  it("suppresses terminal-generated replies but preserves marked user input during replay", () => {
    const guard = createTerminalReplayInputGuard();

    expect(guard.shouldForwardData(true)).toBe(false);
    guard.markUserInput();
    expect(guard.shouldForwardData(true)).toBe(true);
    expect(guard.shouldForwardData(true)).toBe(false);
    expect(guard.shouldForwardData(false)).toBe(true);
  });

  it("resets pending user-input markers", () => {
    const guard = createTerminalReplayInputGuard();
    guard.markUserInput();
    guard.reset();

    expect(guard.shouldForwardData(true)).toBe(false);
  });

  it("subscribes defensively to xterm's pinned user-input signal", () => {
    const dispose = vi.fn();
    const onUserInput = vi.fn(() => ({ dispose }));
    const listener = vi.fn();
    const subscription = subscribeToTerminalUserInput(
      { _core: { coreService: { onUserInput } } },
      listener,
    );

    expect(onUserInput).toHaveBeenCalledWith(listener);
    subscription?.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(subscribeToTerminalUserInput({}, listener)).toBeNull();
  });
});
