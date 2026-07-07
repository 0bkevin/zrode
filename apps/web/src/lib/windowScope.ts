/**
 * Whether this window is a popped-out pane window (terminal, files, chat)
 * rather than the main app window.
 *
 * Popout windows must not share persisted UI state with the main window:
 * the zustand `persist` stores load localStorage into per-window memory and
 * write back debounced, so two windows against the same keys silently
 * overwrite each other. Popout windows therefore run with window-local
 * (in-memory) storage — see `resolveStorage`.
 *
 * Popout-ness is a property of the WINDOW, decided by the URL it booted on,
 * not of the current URL: a history pop commits the new URL before the
 * router (and this check) runs, and a popout that navigates must stay
 * storage-isolated and shell-less either way. The value is therefore
 * captured on first call — which happens during module init of the storage
 * layer, while the boot URL is still current — and frozen.
 *
 * The check covers both history modes: path-based routing on the web
 * (`/popout/...`) and hash-based routing in Electron (`#/popout/...`).
 */

export interface PopoutLocation {
  environmentId: string;
  threadId: string;
  search: Record<string, string>;
}

function parsePopoutLocation(location: Location): PopoutLocation | null {
  const source = location.hash.startsWith("#/")
    ? location.hash.slice(1)
    : `${location.pathname}${location.search}`;
  const match = source.match(/^\/popout\/([^/?]+)\/([^/?]+)(?:\?(.*))?$/);
  if (!match) {
    return null;
  }
  const search: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(match[3] ?? "")) {
    search[key] = value;
  }
  return {
    environmentId: decodeURIComponent(match[1]!),
    threadId: decodeURIComponent(match[2]!),
    search,
  };
}

function currentLocation(): Location | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  // Some test environments provide a window without a location.
  return window.location;
}

let cachedIsPopoutWindow: boolean | null = null;
// The popout route this window is (or was last) on — the "home" the window
// is sent back to when in-app code tries to navigate it out of /popout.
let popoutHomeLocation: PopoutLocation | null = null;

export function isPopoutWindow(): boolean {
  if (cachedIsPopoutWindow !== null) {
    return cachedIsPopoutWindow;
  }
  const location = currentLocation();
  if (location === undefined) {
    // No window yet (SSR/tests) — don't cache a decision.
    return false;
  }
  const home = parsePopoutLocation(location);
  cachedIsPopoutWindow =
    home !== null ||
    location.pathname.startsWith("/popout/") ||
    location.hash.startsWith("#/popout/");
  popoutHomeLocation ??= home;
  return cachedIsPopoutWindow;
}

/**
 * The popout route this window is currently on, falling back to the last
 * popout route it was seen on (e.g. while deciding a navigation whose URL a
 * history pop already committed). Null when the window never was on one.
 */
export function describeCurrentPopoutLocation(): PopoutLocation | null {
  const location = currentLocation();
  if (location !== undefined) {
    const current = parsePopoutLocation(location);
    if (current !== null) {
      popoutHomeLocation = current;
      return current;
    }
  }
  return popoutHomeLocation;
}
