import { describe, expect, it, vi } from "vite-plus/test";

import { createTerminalInputQueue } from "./terminalInputQueue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("createTerminalInputQueue", () => {
  it("preserves input order and coalesces the backlog behind an in-flight write", async () => {
    const firstWrite = deferred();
    const writes: string[] = [];
    const write = vi.fn((data: string) => {
      writes.push(data);
      return writes.length === 1 ? firstWrite.promise : Promise.resolve();
    });
    const queue = createTerminalInputQueue({ write });

    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");
    expect(writes).toEqual(["a"]);

    firstWrite.resolve();
    await queue.waitForDrain();
    expect(writes).toEqual(["a", "bc"]);
    expect(writes.join("")).toBe("abc");
  });

  it("continues draining after a failed write", async () => {
    const onWriteError = vi.fn();
    let callCount = 0;
    const queue = createTerminalInputQueue({
      write: async () => {
        callCount += 1;
        if (callCount === 1) throw new Error("offline");
      },
      onWriteError,
    });

    queue.enqueue("a");
    queue.enqueue("b");
    await queue.waitForDrain();

    expect(onWriteError).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(2);
  });

  it("drops queued input after disposal", async () => {
    const firstWrite = deferred();
    const writes: string[] = [];
    const queue = createTerminalInputQueue({
      write: (data) => {
        writes.push(data);
        return firstWrite.promise;
      },
    });

    queue.enqueue("a");
    queue.enqueue("b");
    queue.dispose();
    firstWrite.resolve();
    await queue.waitForDrain();

    expect(writes).toEqual(["a"]);
  });
});
