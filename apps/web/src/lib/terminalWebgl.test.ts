import type { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vite-plus/test";

import { createTerminalWebglController } from "./terminalWebgl";

function createAddonHarness() {
  let contextLoss: (() => void) | null = null;
  const loseContext = vi.fn();
  const dispose = vi.fn();
  const addon = {
    _renderer: {
      _gl: { getExtension: vi.fn(() => ({ loseContext })) },
      _canvas: { width: 800, height: 400 },
    },
    activate: vi.fn(),
    dispose,
    onContextLoss: vi.fn((listener: () => void) => {
      contextLoss = listener;
      return { dispose: vi.fn() };
    }),
  };
  return {
    addon: addon as unknown as WebglAddon,
    contextLoss: () => contextLoss?.(),
    dispose,
    loseContext,
    canvas: addon._renderer._canvas,
  };
}

describe("terminal WebGL controller", () => {
  it("releases hidden renderers and can reattach when shown again", () => {
    const first = createAddonHarness();
    const second = createAddonHarness();
    const addons = [first.addon, second.addon];
    const terminal = {
      rows: 24,
      loadAddon: vi.fn(),
      refresh: vi.fn(),
    } as unknown as Terminal;
    const controller = createTerminalWebglController(terminal, vi.fn(), () => addons.shift()!);

    expect(controller.attach()).toBe(true);
    expect(controller.attach()).toBe(false);
    expect(controller.dispose()).toBe(true);
    expect(first.loseContext).toHaveBeenCalledOnce();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(first.canvas).toEqual({ width: 0, height: 0 });
    expect(controller.attach()).toBe(true);
    expect(terminal.loadAddon).toHaveBeenCalledTimes(2);
  });

  it("falls back once after context loss without repeatedly allocating broken contexts", () => {
    const addon = createAddonHarness();
    const onFallback = vi.fn();
    const createAddon = vi.fn(() => addon.addon);
    const terminal = {
      rows: 24,
      loadAddon: vi.fn(),
      refresh: vi.fn(),
    } as unknown as Terminal;
    const controller = createTerminalWebglController(terminal, onFallback, createAddon);

    expect(controller.attach()).toBe(true);
    addon.contextLoss();
    expect(onFallback).toHaveBeenCalledOnce();
    expect(addon.dispose).toHaveBeenCalledOnce();
    expect(controller.attach()).toBe(false);
    expect(createAddon).toHaveBeenCalledOnce();
  });
});
