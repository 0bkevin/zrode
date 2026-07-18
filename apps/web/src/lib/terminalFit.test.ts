import { describe, expect, it, vi } from "vite-plus/test";

import { createTerminalFitController } from "./terminalFit";

function createFrameHarness() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  return {
    requestFrame: (callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelFrame: (id: number) => callbacks.delete(id),
    flush: () => {
      const batch = [...callbacks.values()];
      callbacks.clear();
      for (const callback of batch) callback(0);
    },
    size: () => callbacks.size,
  };
}

function createHarness() {
  const frames = createFrameHarness();
  let dimensions = { cols: 80, rows: 24 };
  const terminal = {
    cols: 40,
    rows: 10,
    buffer: { active: { viewportY: 5, baseY: 5 } },
    scrollToBottom: vi.fn(),
  };
  const fitAddon = {
    proposeDimensions: vi.fn(() => dimensions),
    fit: vi.fn(() => {
      terminal.cols = dimensions.cols;
      terminal.rows = dimensions.rows;
    }),
  };
  const onGeometry = vi.fn();
  const controller = createTerminalFitController({
    container: {
      getBoundingClientRect: () => ({ width: 800, height: 400 }),
    } as HTMLElement,
    terminal: terminal as never,
    fitAddon,
    onGeometry,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    createResizeObserver: null,
  });
  return {
    controller,
    fitAddon,
    frames,
    onGeometry,
    terminal,
    setDimensions: (next: { cols: number; rows: number }) => {
      dimensions = next;
    },
  };
}

describe("createTerminalFitController", () => {
  it("fits after the proposed grid is stable and publishes the PTY geometry", () => {
    const harness = createHarness();
    harness.frames.flush();

    expect(harness.fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(harness.onGeometry).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    expect(harness.terminal.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("coalesces repeated resize requests and waits for layout stability", () => {
    const harness = createHarness();
    harness.controller.requestFit();
    harness.controller.requestFit();
    expect(harness.frames.size()).toBe(1);

    harness.setDimensions({ cols: 90, rows: 24 });
    harness.frames.flush();
    expect(harness.fitAddon.fit).not.toHaveBeenCalled();

    harness.frames.flush();
    expect(harness.fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(harness.onGeometry).toHaveBeenCalledWith({ cols: 90, rows: 24 });
  });

  it("does not refit when the terminal already has the proposed grid", () => {
    const harness = createHarness();
    harness.terminal.cols = 80;
    harness.terminal.rows = 24;
    harness.frames.flush();

    expect(harness.fitAddon.fit).not.toHaveBeenCalled();
    expect(harness.onGeometry).toHaveBeenCalledWith({ cols: 80, rows: 24 });
  });

  it("does not republish unchanged geometry on redundant observer notifications", () => {
    const harness = createHarness();
    harness.frames.flush();
    harness.controller.requestFit();
    harness.frames.flush();

    expect(harness.onGeometry).toHaveBeenCalledTimes(1);
  });

  it("cancels pending stabilization work when disposed", () => {
    const harness = createHarness();
    expect(harness.frames.size()).toBe(1);

    harness.controller.dispose();

    expect(harness.frames.size()).toBe(0);
    harness.frames.flush();
    expect(harness.fitAddon.fit).not.toHaveBeenCalled();
  });

  it("waits for a hidden container to become measurable", () => {
    const frames = createFrameHarness();
    let width = 0;
    let resizeCallback: ResizeObserverCallback = () => undefined;
    const terminal = {
      cols: 40,
      rows: 10,
      buffer: { active: { viewportY: 0, baseY: 0 } },
      scrollToBottom: vi.fn(),
    };
    const fitAddon = {
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
      fit: vi.fn(() => {
        terminal.cols = 80;
        terminal.rows = 24;
      }),
    };
    createTerminalFitController({
      container: {
        getBoundingClientRect: () => ({ width, height: width / 2 }),
      } as HTMLElement,
      terminal: terminal as never,
      fitAddon,
      onGeometry: vi.fn(),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
      createResizeObserver: (callback) => {
        resizeCallback = callback;
        return { observe: vi.fn(), disconnect: vi.fn() };
      },
    });

    expect(frames.size()).toBe(0);
    width = 800;
    resizeCallback([], {} as ResizeObserver);
    expect(frames.size()).toBe(1);
    frames.flush();
    expect(fitAddon.fit).toHaveBeenCalledOnce();
  });

  it("supports small but valid split panes", () => {
    const frames = createFrameHarness();
    const terminal = {
      cols: 1,
      rows: 1,
      buffer: { active: { viewportY: 0, baseY: 0 } },
      scrollToBottom: vi.fn(),
    };
    const onGeometry = vi.fn();
    createTerminalFitController({
      container: {
        getBoundingClientRect: () => ({ width: 8, height: 8 }),
      } as HTMLElement,
      terminal: terminal as never,
      fitAddon: { proposeDimensions: () => ({ cols: 1, rows: 1 }), fit: vi.fn() },
      onGeometry,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
      createResizeObserver: null,
    });

    frames.flush();
    expect(onGeometry).toHaveBeenCalledWith({ cols: 1, rows: 1 });
  });
});
