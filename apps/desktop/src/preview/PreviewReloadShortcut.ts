import type * as Electron from "electron";

export type PreviewReloadKind = "reload" | "hardReload";
export type PreviewReloadAction = PreviewReloadKind | "suppress";

type PreviewReloadShortcutInput = Pick<
  Electron.Input,
  "alt" | "control" | "isAutoRepeat" | "key" | "meta" | "shift" | "type"
>;

/**
 * Resolves browser-style reload chords while a preview guest owns keyboard
 * focus. The native application menu would otherwise apply these shortcuts to
 * the host window and reload the entire Zrode renderer.
 */
export function resolvePreviewReloadShortcut(
  input: PreviewReloadShortcutInput,
  platform: NodeJS.Platform,
): PreviewReloadAction | null {
  if (input.type !== "keyDown" || input.key.toLowerCase() !== "r" || input.alt) {
    return null;
  }
  const hasPlatformModifier =
    platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  if (!hasPlatformModifier) {
    return null;
  }
  // Keep consuming a held reload chord so Electron's host-window accelerator
  // cannot take over, but avoid repeatedly restarting the preview navigation.
  if (input.isAutoRepeat) return "suppress";
  return input.shift ? "hardReload" : "reload";
}
