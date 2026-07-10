export const FILE_EXPLORER_DEFAULT_WIDTH = 320;
export const FILE_EXPLORER_MIN_WIDTH = 240;
export const FILE_EXPLORER_MAX_WIDTH = 520;

const FILE_EXPLORER_MAX_CONTAINER_FRACTION = 0.46;

/**
 * Keep enough of the split container available for the file preview while
 * preserving a usable explorer minimum in unusually narrow panels.
 */
export function resolveFileExplorerMaxWidth(containerWidth: number | null): number {
  if (containerWidth === null || !Number.isFinite(containerWidth) || containerWidth <= 0) {
    return FILE_EXPLORER_MAX_WIDTH;
  }
  return Math.max(
    FILE_EXPLORER_MIN_WIDTH,
    Math.min(
      FILE_EXPLORER_MAX_WIDTH,
      Math.floor(containerWidth * FILE_EXPLORER_MAX_CONTAINER_FRACTION),
    ),
  );
}
