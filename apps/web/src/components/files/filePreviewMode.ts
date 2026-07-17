import {
  isWorkspaceImagePreviewPath,
  isWorkspacePdfPreviewPath,
} from "@t3tools/shared/filePreview";

export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

export type WorkspaceAssetPreviewKind = "image" | "pdf";

export function workspaceAssetPreviewKind(path: string): WorkspaceAssetPreviewKind | null {
  if (isWorkspaceImagePreviewPath(path)) return "image";
  if (isWorkspacePdfPreviewPath(path)) return "pdf";
  return null;
}

export function workspaceFileNeedsTextDocument(path: string): boolean {
  return workspaceAssetPreviewKind(path) === null;
}

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}
