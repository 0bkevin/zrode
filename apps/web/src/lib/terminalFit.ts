import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

export interface TerminalGeometry {
  readonly cols: number;
  readonly rows: number;
}

interface TerminalFitControllerOptions {
  readonly container: HTMLElement;
  readonly terminal: Pick<Terminal, "buffer" | "cols" | "rows" | "scrollToBottom">;
  readonly fitAddon: Pick<FitAddon, "fit" | "proposeDimensions">;
  readonly onGeometry: (geometry: TerminalGeometry) => void;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly createResizeObserver?:
    | ((callback: ResizeObserverCallback) => Pick<ResizeObserver, "disconnect" | "observe">)
    | null;
}

export interface TerminalFitController {
  readonly requestFit: () => void;
  readonly dispose: () => void;
}

const MAX_STABILITY_FRAMES = 8;
const MIN_FIT_WIDTH_PX = 1;
const MIN_FIT_HEIGHT_PX = 1;
const MIN_FIT_COLS = 1;
const MIN_FIT_ROWS = 1;

function sameGeometry(left: TerminalGeometry | null, right: TerminalGeometry | null): boolean {
  return left?.cols === right?.cols && left?.rows === right?.rows;
}

function hasMeasurableContainer(container: HTMLElement): boolean {
  const rect = container.getBoundingClientRect();
  return rect.width >= MIN_FIT_WIDTH_PX && rect.height >= MIN_FIT_HEIGHT_PX;
}

function proposedGeometry(fitAddon: Pick<FitAddon, "proposeDimensions">): TerminalGeometry | null {
  try {
    const dimensions = fitAddon.proposeDimensions();
    if (!dimensions || dimensions.cols < MIN_FIT_COLS || dimensions.rows < MIN_FIT_ROWS) {
      return null;
    }
    return dimensions;
  } catch {
    return null;
  }
}

/**
 * Keeps xterm's grid synchronized with its actual pane. ResizeObserver catches
 * width-only layout changes; the stability frames avoid SIGWINCH churn while a
 * split or sidebar is still animating.
 */
export function createTerminalFitController(
  options: TerminalFitControllerOptions,
): TerminalFitController {
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  const createResizeObserver =
    options.createResizeObserver === undefined
      ? typeof ResizeObserver === "undefined"
        ? null
        : (callback: ResizeObserverCallback) => new ResizeObserver(callback)
      : options.createResizeObserver;
  let pendingFrame: number | null = null;
  let disposed = false;
  let publishedGeometry: TerminalGeometry | null = null;

  const publishCurrentGeometry = () => {
    if (options.terminal.cols < MIN_FIT_COLS || options.terminal.rows < MIN_FIT_ROWS) return;
    const geometry = { cols: options.terminal.cols, rows: options.terminal.rows };
    if (sameGeometry(publishedGeometry, geometry)) return;
    publishedGeometry = geometry;
    options.onGeometry(geometry);
  };

  const fit = () => {
    if (disposed || !hasMeasurableContainer(options.container)) return;
    const dimensions = proposedGeometry(options.fitAddon);
    if (!dimensions) return;
    if (options.terminal.cols === dimensions.cols && options.terminal.rows === dimensions.rows) {
      publishCurrentGeometry();
      return;
    }

    const wasAtBottom =
      options.terminal.buffer.active.viewportY >= options.terminal.buffer.active.baseY;
    try {
      options.fitAddon.fit();
    } catch {
      // A pane can become hidden between measurement and fit. Its next visible
      // ResizeObserver notification will retry with authoritative geometry.
      return;
    }
    if (wasAtBottom) {
      try {
        options.terminal.scrollToBottom();
      } catch {
        // Scroll restoration must never prevent the PTY geometry from syncing.
      }
    }
    publishCurrentGeometry();
  };

  const requestFit = () => {
    if (disposed || pendingFrame !== null || !hasMeasurableContainer(options.container)) return;

    let previous = proposedGeometry(options.fitAddon);
    let frameCount = 0;
    const waitForStableGrid = () => {
      pendingFrame = requestFrame(() => {
        pendingFrame = null;
        if (disposed || !hasMeasurableContainer(options.container)) return;

        const next = proposedGeometry(options.fitAddon);
        frameCount += 1;
        if (
          !next ||
          sameGeometry(previous, next) ||
          (options.terminal.cols === next.cols && options.terminal.rows === next.rows) ||
          frameCount >= MAX_STABILITY_FRAMES
        ) {
          fit();
          return;
        }
        previous = next;
        waitForStableGrid();
      });
    };
    waitForStableGrid();
  };

  const observer = createResizeObserver?.(() => requestFit()) ?? null;
  observer?.observe(options.container);
  requestFit();

  return {
    requestFit,
    dispose: () => {
      disposed = true;
      observer?.disconnect();
      if (pendingFrame !== null) {
        cancelFrame(pendingFrame);
        pendingFrame = null;
      }
    },
  };
}
