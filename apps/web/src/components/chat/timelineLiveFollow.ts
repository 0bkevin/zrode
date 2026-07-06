export function shouldRestoreTimelineLiveFollowAtEnd({
  userScrollGeneration,
  currentUserScrollGeneration,
  isAtEnd,
  scrollOffset,
  currentScrollOffset,
  maxScrollDelta = 1,
}: {
  readonly userScrollGeneration: number;
  readonly currentUserScrollGeneration: number;
  readonly isAtEnd: boolean | undefined;
  readonly scrollOffset: number | undefined;
  readonly currentScrollOffset: number | undefined;
  readonly maxScrollDelta?: number;
}) {
  if (userScrollGeneration !== currentUserScrollGeneration || isAtEnd !== true) {
    return false;
  }
  if (typeof scrollOffset !== "number" || typeof currentScrollOffset !== "number") {
    return true;
  }
  return Math.abs(currentScrollOffset - scrollOffset) <= maxScrollDelta;
}
