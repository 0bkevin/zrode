import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

interface WebglAddonInternals {
  readonly _renderer?: {
    readonly _gl?: WebGLRenderingContext | WebGL2RenderingContext;
    readonly _canvas?: HTMLCanvasElement;
  };
}

export interface TerminalWebglController {
  attach(): boolean;
  dispose(): boolean;
}

function releaseWebglContext(addon: WebglAddon): void {
  try {
    const renderer = (addon as WebglAddon & WebglAddonInternals)._renderer;
    renderer?._gl?.getExtension("WEBGL_lose_context")?.loseContext();
    if (renderer?._canvas) {
      renderer._canvas.width = 0;
      renderer._canvas.height = 0;
    }
  } catch {
    // Best-effort release for Chromium's small per-page WebGL context budget.
  }
}

export function createTerminalWebglController(
  terminal: Terminal,
  onRendererFallback: () => void,
  createAddon: () => WebglAddon = () => new WebglAddon(),
): TerminalWebglController {
  let addon: WebglAddon | null = null;
  let unavailable = false;

  const dispose = (): boolean => {
    const activeAddon = addon;
    if (!activeAddon) return false;
    addon = null;
    releaseWebglContext(activeAddon);
    try {
      activeAddon.dispose();
    } catch {
      // A lost context may already have disposed the renderer.
    }
    return true;
  };

  const attach = (): boolean => {
    if (addon || unavailable) return false;
    let nextAddon: WebglAddon | null = null;
    try {
      nextAddon = createAddon();
      addon = nextAddon;
      nextAddon.onContextLoss(() => {
        if (addon !== nextAddon) return;
        unavailable = true;
        dispose();
        try {
          onRendererFallback();
        } catch {
          // Renderer recovery must not escape xterm's context-loss event.
        }
      });
      terminal.loadAddon(nextAddon);
      terminal.refresh(0, terminal.rows - 1);
      return true;
    } catch {
      if (nextAddon && addon === nextAddon) dispose();
      unavailable = true;
      return false;
    }
  };

  return { attach, dispose };
}
