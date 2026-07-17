import { WORKSPACE_ASSET_PREVIEW_CONTENT_TYPES } from "@t3tools/shared/filePreview";

/** MIME types allowed behind a workspace browser-preview capability. */
export const WORKSPACE_ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ...WORKSPACE_ASSET_PREVIEW_CONTENT_TYPES,
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export const WORKSPACE_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(WORKSPACE_ASSET_CONTENT_TYPES),
);
