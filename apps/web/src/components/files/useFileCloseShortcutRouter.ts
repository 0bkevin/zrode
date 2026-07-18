import { useEffect } from "react";

import {
  DesktopCloseActiveFileOrWindowAction,
  isCloseActiveFileShortcut,
  requestActiveFileClose,
} from "./fileCloseShortcut";

/**
 * Routes Cmd/Ctrl+W to the active file before the desktop shell can close the
 * containing OS window. Mount once in each renderer window.
 */
export function useFileCloseShortcutRouter(): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !isCloseActiveFileShortcut(event)) return;
      if (!requestActiveFileClose()) return;

      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action !== DesktopCloseActiveFileOrWindowAction) return;
      if (!requestActiveFileClose()) {
        window.close();
      }
    });

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      unsubscribe?.();
    };
  }, []);
}
