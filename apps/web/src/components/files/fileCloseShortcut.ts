import { DesktopCloseActiveFileOrWindowAction } from "@t3tools/contracts";

interface CloseShortcutEvent {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

interface ActiveFileCloseRegistration {
  readonly close: () => void;
}

let activeFileCloseRegistration: ActiveFileCloseRegistration | null = null;

export { DesktopCloseActiveFileOrWindowAction };

export function isCloseActiveFileShortcut(event: CloseShortcutEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "w"
  );
}

export function registerActiveFileCloseHandler(close: () => void): () => void {
  const registration = { close };
  activeFileCloseRegistration = registration;

  return () => {
    if (activeFileCloseRegistration === registration) {
      activeFileCloseRegistration = null;
    }
  };
}

export function requestActiveFileClose(): boolean {
  const registration = activeFileCloseRegistration;
  if (!registration) return false;
  registration.close();
  return true;
}
