import type { FileRevealTarget } from "~/rightPanelStore";

export interface PopoutFileTab {
  readonly relativePath: string;
  readonly revealTarget: FileRevealTarget | null;
  readonly revealRequestId: number;
}

export interface PopoutFileTabsState {
  readonly tabs: readonly PopoutFileTab[];
  readonly activePath: string | null;
}

function nextRequestId(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

export function createPopoutFileTabsState(initialPath: string | null): PopoutFileTabsState {
  if (initialPath === null) return { tabs: [], activePath: null };
  return {
    tabs: [{ relativePath: initialPath, revealTarget: null, revealRequestId: 0 }],
    activePath: initialPath,
  };
}

export function openPopoutFileTab(
  current: PopoutFileTabsState,
  relativePath: string,
  revealTarget: FileRevealTarget | null,
): PopoutFileTabsState {
  const existing = current.tabs.find((tab) => tab.relativePath === relativePath);
  const nextTab: PopoutFileTab = {
    relativePath,
    revealTarget,
    revealRequestId: nextRequestId(existing?.revealRequestId ?? 0),
  };
  return {
    tabs: existing
      ? current.tabs.map((tab) => (tab.relativePath === relativePath ? nextTab : tab))
      : [...current.tabs, nextTab],
    activePath: relativePath,
  };
}

export function activatePopoutFileTab(
  current: PopoutFileTabsState,
  relativePath: string,
): PopoutFileTabsState {
  if (
    current.activePath === relativePath ||
    !current.tabs.some((tab) => tab.relativePath === relativePath)
  ) {
    return current;
  }
  return { ...current, activePath: relativePath };
}

export function closePopoutFileTabs(
  current: PopoutFileTabsState,
  relativePaths: ReadonlySet<string>,
): PopoutFileTabsState {
  const closedTabs = current.tabs.filter((tab) => relativePaths.has(tab.relativePath));
  if (closedTabs.length === 0) return current;

  const tabs = current.tabs.filter((tab) => !relativePaths.has(tab.relativePath));
  if (current.activePath === null || !relativePaths.has(current.activePath)) {
    return { tabs, activePath: current.activePath };
  }

  const activeIndex = current.tabs.findIndex((tab) => tab.relativePath === current.activePath);
  const nextTab = current.tabs
    .slice(activeIndex + 1)
    .find((tab) => !relativePaths.has(tab.relativePath));
  const previousTab = current.tabs
    .slice(0, activeIndex)
    .toReversed()
    .find((tab) => !relativePaths.has(tab.relativePath));
  return { tabs, activePath: nextTab?.relativePath ?? previousTab?.relativePath ?? null };
}
