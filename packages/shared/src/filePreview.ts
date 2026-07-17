export const WORKSPACE_HTML_PREVIEW_EXTENSIONS = [".htm", ".html"] as const;

export const WORKSPACE_PDF_PREVIEW_CONTENT_TYPES = {
  ".pdf": "application/pdf",
} as const;

export const WORKSPACE_PDF_PREVIEW_EXTENSIONS = Object.keys(WORKSPACE_PDF_PREVIEW_CONTENT_TYPES);

export const WORKSPACE_BROWSER_PREVIEW_EXTENSIONS = [
  ...WORKSPACE_HTML_PREVIEW_EXTENSIONS,
  ...WORKSPACE_PDF_PREVIEW_EXTENSIONS,
] as const;

export const WORKSPACE_IMAGE_PREVIEW_CONTENT_TYPES = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".cur": "image/x-icon",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jfif": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pjp": "image/jpeg",
  ".pjpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
} as const;

export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = Object.keys(
  WORKSPACE_IMAGE_PREVIEW_CONTENT_TYPES,
);

export const WORKSPACE_ASSET_PREVIEW_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ...WORKSPACE_IMAGE_PREVIEW_CONTENT_TYPES,
  ...WORKSPACE_PDF_PREVIEW_CONTENT_TYPES,
};

function hasPreviewExtension(path: string, extensions: ReadonlyArray<string>): boolean {
  const pathWithoutQuery = path.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  return extensions.some((extension) => pathWithoutQuery.endsWith(extension));
}

export function isWorkspaceBrowserPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_BROWSER_PREVIEW_EXTENSIONS);
}

export function isWorkspaceHtmlPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_HTML_PREVIEW_EXTENSIONS);
}

export function isWorkspacePdfPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_PDF_PREVIEW_EXTENSIONS);
}

export function isWorkspaceImagePreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_IMAGE_PREVIEW_EXTENSIONS);
}

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceImagePreviewPath(path);
}
