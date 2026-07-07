import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

/**
 * A pane that can be hosted in its own OS window at a /popout/ route.
 *
 * Terminal and files panes are fully server-backed (the PTY buffer and the
 * filesystem live on the server), so a pane window reconstructs its content
 * from a fresh connection — nothing is transferred from the source window.
 */
export type PaneWindowTarget =
  | {
      kind: "terminal";
      environmentId: EnvironmentId;
      threadId: ThreadId;
      terminalIds: readonly string[];
      activeTerminalId: string;
    }
  | {
      kind: "files";
      environmentId: EnvironmentId;
      threadId: ThreadId;
      // Relative path of a file to open, or null/undefined for the tree.
      path?: string | null;
    }
  | {
      // A full chat view for a started server thread. Messages and turns are
      // server-owned, so the window renders the same live thread; only the
      // composer draft is window-local (see resolveStorage popout isolation).
      kind: "chat";
      environmentId: EnvironmentId;
      threadId: ThreadId;
    };

const PANE_WINDOW_SIZES = {
  terminal: { width: 960, height: 620 },
  files: { width: 1100, height: 740 },
  chat: { width: 1000, height: 780 },
} as const;

export function buildPaneWindowPath(target: PaneWindowTarget): string {
  const search = new URLSearchParams({ kind: target.kind });
  if (target.kind === "terminal") {
    search.set("terminalIds", target.terminalIds.join(","));
    search.set("activeTerminalId", target.activeTerminalId);
  } else if (target.kind === "files" && target.path) {
    search.set("path", target.path);
  }
  return `/popout/${encodeURIComponent(target.environmentId)}/${encodeURIComponent(target.threadId)}?${search.toString()}`;
}

export function paneWindowTitle(target: PaneWindowTarget): string {
  switch (target.kind) {
    case "terminal":
      return "Terminal";
    case "chat":
      return "Chat";
    case "files":
      return target.path ? target.path.slice(target.path.lastIndexOf("/") + 1) : "Files";
  }
}

/**
 * Open a pane in a separate OS window: a real Electron window on desktop, a
 * popup window in the browser. Resolves false when the window could not be
 * opened (denied by the main process, or blocked by the browser).
 */
export async function openPaneWindow(target: PaneWindowTarget): Promise<boolean> {
  const path = buildPaneWindowPath(target);
  const { width, height } = PANE_WINDOW_SIZES[target.kind];

  if (window.desktopBridge) {
    return window.desktopBridge.openPaneWindow({
      path,
      title: paneWindowTitle(target),
      width,
      height,
    });
  }

  const opened = window.open(
    `${window.location.origin}${path}`,
    "_blank",
    `popup=yes,width=${width},height=${height}`,
  );
  return opened !== null;
}
