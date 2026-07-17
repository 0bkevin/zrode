import { describe, expect, it } from "vite-plus/test";

import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceHtmlPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePdfPreviewPath,
  isWorkspacePreviewEntryPath,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  it.each(["report.html", "report.HTM", "document.pdf?download=1"])(
    "recognizes browser preview path %s",
    (path) => {
      expect(isWorkspaceBrowserPreviewPath(path)).toBe(true);
      expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    },
  );

  it("distinguishes HTML and PDF browser previews", () => {
    expect(isWorkspaceHtmlPreviewPath("report.HTML")).toBe(true);
    expect(isWorkspaceHtmlPreviewPath("report.pdf")).toBe(false);
    expect(isWorkspacePdfPreviewPath("report.PDF#page=2")).toBe(true);
    expect(isWorkspacePdfPreviewPath("report.html")).toBe(false);
  });

  it.each([
    "icon.png",
    "animation.apng",
    "photo.JPEG",
    "photo.jfif",
    "photo.pjpeg",
    "animation.gif",
    "bitmap.bmp",
    "pointer.cur",
    "vector.svg#mark",
    "texture.webp",
    "image.avif",
  ])("recognizes image preview path %s", (path) => {
    expect(isWorkspaceImagePreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each(["README.md", "src/index.ts", "image.png.ts", "png"])(
    "rejects non-preview path %s",
    (path) => {
      expect(isWorkspacePreviewEntryPath(path)).toBe(false);
    },
  );
});
