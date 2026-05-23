import { describe, expect, it } from "vitest";

import {
  fileLanguageFromPath,
  isPdfMimeType,
  latexDocumentToMarkdown,
  textPreviewKindForPath,
} from "./fileContentPreview";

describe("fileContentPreview", () => {
  it("classifies previewable text formats", () => {
    expect(textPreviewKindForPath("README.md")).toBe("markdown");
    expect(textPreviewKindForPath("paper.tex")).toBe("latex");
    expect(textPreviewKindForPath("src/index.ts")).toBe(null);
  });

  it("detects pdf MIME types", () => {
    expect(isPdfMimeType("application/pdf")).toBe(true);
    expect(isPdfMimeType("application/octet-stream")).toBe(false);
    expect(isPdfMimeType(undefined)).toBe(false);
  });

  it("returns editor languages for markdown and latex files", () => {
    expect(fileLanguageFromPath("README.mdx")).toBe("markdown");
    expect(fileLanguageFromPath("paper.ltx")).toBe("latex");
  });

  it("returns Monaco language ids for common code files", () => {
    expect(fileLanguageFromPath("src/App.tsx")).toBe("typescript");
    expect(fileLanguageFromPath("src/App.jsx")).toBe("javascript");
    expect(fileLanguageFromPath("src/main.rs")).toBe("rust");
    expect(fileLanguageFromPath("src/components/App.vue")).toBe("vue");
    expect(fileLanguageFromPath("src/routes/+page.svelte")).toBe("svelte");
    expect(fileLanguageFromPath("src/pages/index.astro")).toBe("astro");
  });

  it("detects language ids from exact filenames", () => {
    expect(fileLanguageFromPath("Dockerfile")).toBe("dockerfile");
    expect(fileLanguageFromPath("/repo/.gitignore")).toBe("ini");
    expect(fileLanguageFromPath("CMakeLists.txt")).toBe("cmake");
  });

  it("turns common LaTeX document structure into markdown preview text", () => {
    const result = latexDocumentToMarkdown(String.raw`
\documentclass{article}
\title{Notes}
\begin{document}
\maketitle
\section{Result}
The value is \(x^2\).
\begin{equation}
E = mc^2
\end{equation}
\begin{itemize}
\item first
\item second
\end{itemize}
\end{document}
`);

    expect(result).toContain("# Notes");
    expect(result).toContain("# Result");
    expect(result).toContain("The value is $x^2$.");
    expect(result).toContain("$$\nE = mc^2\n$$");
    expect(result).toContain("- first");
    expect(result).toContain("- second");
  });
});
