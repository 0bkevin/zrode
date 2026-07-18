interface Disposable {
  dispose(): void;
}

interface XtermUserInputInternals {
  readonly _core?: {
    readonly coreService?: {
      onUserInput(listener: () => void): Disposable;
    };
  };
}

export interface TerminalReplayInputGuard {
  markUserInput(): void;
  shouldForwardData(replayInProgress: boolean): boolean;
  reset(): void;
}

/**
 * Distinguishes user input from xterm's automatic device-query replies while
 * persisted output is being parsed. xterm synchronously emits onUserInput
 * immediately before onData for keyboard and paste input.
 */
export function createTerminalReplayInputGuard(): TerminalReplayInputGuard {
  let pendingUserInputEvents = 0;

  return {
    markUserInput() {
      pendingUserInputEvents += 1;
    },
    shouldForwardData(replayInProgress) {
      const isUserInput = pendingUserInputEvents > 0;
      if (isUserInput) pendingUserInputEvents -= 1;
      return !replayInProgress || isUserInput;
    },
    reset() {
      pendingUserInputEvents = 0;
    },
  };
}

export function subscribeToTerminalUserInput(
  terminal: unknown,
  listener: () => void,
): Disposable | null {
  const coreService = (terminal as XtermUserInputInternals | null)?._core?.coreService;
  if (typeof coreService?.onUserInput !== "function") return null;

  try {
    return coreService.onUserInput(listener);
  } catch {
    return null;
  }
}
