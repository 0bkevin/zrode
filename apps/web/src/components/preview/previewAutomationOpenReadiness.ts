import type { PreviewAutomationOpenInput, PreviewSessionSnapshot } from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";

export function previewAutomationOpenNeedsOverlay(
  input: PreviewAutomationOpenInput,
  snapshot: PreviewSessionSnapshot,
): boolean {
  return input.url !== undefined || snapshot.navStatus._tag !== "Idle";
}

export function previewAutomationOpenNeedsNavigation(
  input: PreviewAutomationOpenInput,
  snapshot: PreviewSessionSnapshot,
  reusedFromLocalState: boolean,
): boolean {
  if (input.url === undefined) return false;
  if (reusedFromLocalState || snapshot.navStatus._tag === "Idle") return true;
  try {
    return normalizePreviewUrl(input.url) !== snapshot.navStatus.url;
  } catch {
    // Let the desktop navigation path return its structured URL error.
    return true;
  }
}
