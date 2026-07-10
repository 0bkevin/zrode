import type { FileDocumentSnapshot } from "./fileDocumentStore";

type FileSurfaceLike = { readonly relativePath: string };

export function fileDocumentNeedsCloseProtection(
  snapshot: Pick<FileDocumentSnapshot, "isDirty" | "status"> | null,
): boolean {
  return (
    snapshot?.isDirty === true || snapshot?.status === "saving" || snapshot?.status === "retrying"
  );
}

/** Synchronous final guard used immediately before the captured-ID mutation. */
export function capturedFileDocumentsAreSafe(
  surfaces: readonly FileSurfaceLike[],
  getSnapshot: (relativePath: string) => Pick<FileDocumentSnapshot, "isDirty" | "status"> | null,
): boolean {
  return surfaces.every(
    (surface) => !fileDocumentNeedsCloseProtection(getSnapshot(surface.relativePath)),
  );
}
