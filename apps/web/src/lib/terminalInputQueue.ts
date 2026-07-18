export const TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS = 4_096;

interface TerminalInputQueueOptions {
  readonly write: (data: string) => Promise<void>;
  readonly onWriteError?: (error: unknown) => void;
}

export interface TerminalInputQueue {
  readonly enqueue: (data: string) => void;
  readonly waitForDrain: () => Promise<void>;
  readonly dispose: () => void;
}

/** Serializes the input byte stream and coalesces any backlog behind an in-flight RPC. */
export function createTerminalInputQueue(options: TerminalInputQueueOptions): TerminalInputQueue {
  let pending: string[] = [];
  let drainPromise: Promise<void> | null = null;
  let disposed = false;

  const drain = async () => {
    while (pending.length > 0) {
      if (disposed) return;
      let payload = pending.shift() ?? "";
      while (pending.length > 0) {
        const next = pending[0];
        if (
          next === undefined ||
          payload.length + next.length > TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS
        ) {
          break;
        }
        payload += next;
        pending.shift();
      }
      if (payload.length === 0) continue;

      try {
        await options.write(payload);
      } catch (error) {
        try {
          options.onWriteError?.(error);
        } catch {
          // Error presentation must not break ordering for later input.
        }
      }
    }
  };

  const scheduleDrain = () => {
    if (disposed || drainPromise !== null) return;
    drainPromise = drain().finally(() => {
      drainPromise = null;
      if (!disposed && pending.length > 0) {
        scheduleDrain();
      }
    });
  };

  return {
    enqueue: (data) => {
      if (disposed || data.length === 0) return;
      pending.push(data);
      scheduleDrain();
    },
    waitForDrain: async () => {
      for (;;) {
        const activeDrain = drainPromise;
        if (activeDrain === null) return;
        await activeDrain;
      }
    },
    dispose: () => {
      disposed = true;
      pending = [];
    },
  };
}
