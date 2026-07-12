export const WORKSPACE_SEARCH_ROW_HEIGHT = 24;
export const WORKSPACE_SEARCH_OVERSCAN_ROWS = 8;

export interface WorkspaceSearchVirtualWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly offsetTop: number;
  readonly totalHeight: number;
}

export function calculateWorkspaceSearchVirtualWindow({
  rowCount,
  scrollTop,
  viewportHeight,
  rowHeight = WORKSPACE_SEARCH_ROW_HEIGHT,
  overscanRows = WORKSPACE_SEARCH_OVERSCAN_ROWS,
}: {
  readonly rowCount: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly rowHeight?: number;
  readonly overscanRows?: number;
}): WorkspaceSearchVirtualWindow {
  const safeRowCount = Number.isFinite(rowCount) ? Math.max(0, Math.floor(rowCount)) : 0;
  const safeRowHeight = Number.isFinite(rowHeight) ? Math.max(1, rowHeight) : 1;
  const safeViewportHeight = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const safeOverscanRows = Number.isFinite(overscanRows)
    ? Math.max(0, Math.floor(overscanRows))
    : 0;
  const totalHeight = safeRowCount * safeRowHeight;

  if (safeRowCount === 0) {
    return { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0 };
  }

  // Content can shrink substantially when a result group is collapsed. Clamp
  // stale React scroll state to the new extent so that the window never goes
  // blank while the browser catches up and clamps the element's scrollTop.
  const maxScrollTop = Math.max(0, totalHeight - safeViewportHeight);
  const safeScrollTop = Math.min(
    Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0),
    maxScrollTop,
  );
  const firstVisibleIndex = Math.floor(safeScrollTop / safeRowHeight);
  const visibleEndIndex = Math.max(
    firstVisibleIndex + 1,
    Math.ceil((safeScrollTop + safeViewportHeight) / safeRowHeight),
  );
  const startIndex = Math.max(0, firstVisibleIndex - safeOverscanRows);
  const endIndex = Math.min(safeRowCount, visibleEndIndex + safeOverscanRows);

  return {
    startIndex,
    endIndex,
    offsetTop: startIndex * safeRowHeight,
    totalHeight,
  };
}
