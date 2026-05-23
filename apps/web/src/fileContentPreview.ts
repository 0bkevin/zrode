export type TextPreviewKind = "markdown" | "latex" | null;

function extname(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastDot <= lastSep) {
    return "";
  }
  return filePath.slice(lastDot);
}

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".jsonc": "json",
  ".ipynb": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".mmd": "mermaid",
  ".mermaid": "mermaid",
  ".tex": "latex",
  ".ltx": "latex",
  ".latex": "latex",
  ".bib": "latex",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".svg": "xml",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".fish": "shell",
  ".ps1": "powershell",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "ini",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".dockerfile": "dockerfile",
  ".proto": "protobuf",
  ".lua": "lua",
  ".r": "r",
  ".scala": "scala",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hrl": "erlang",
  ".hs": "haskell",
  ".clj": "clojure",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".tf": "hcl",
  ".hcl": "hcl",
  ".prisma": "graphql",
  ".csv": "csv",
  ".tsv": "tsv",
};

const FILENAME_TO_LANGUAGE: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  "CMakeLists.txt": "cmake",
  ".gitignore": "ini",
  ".gitattributes": "ini",
  ".editorconfig": "ini",
  ".env": "ini",
  ".env.local": "ini",
  ".env.development": "ini",
  ".env.production": "ini",
};

export function fileLanguageFromPath(pathValue: string): string {
  const normalizedPath = pathValue.replaceAll("\\", "/");
  const filename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  const exactLanguage = FILENAME_TO_LANGUAGE[filename];
  if (exactLanguage) return exactLanguage;

  const extension = extname(filename).toLowerCase();
  return EXTENSION_TO_LANGUAGE[extension] ?? "plaintext";
}

export function isMarkdownPath(pathValue: string): boolean {
  const lowerPath = pathValue.toLowerCase();
  return lowerPath.endsWith(".md") || lowerPath.endsWith(".mdx") || lowerPath.endsWith(".markdown");
}

export function isLatexPath(pathValue: string): boolean {
  const lowerPath = pathValue.toLowerCase();
  return (
    lowerPath.endsWith(".tex") ||
    lowerPath.endsWith(".ltx") ||
    lowerPath.endsWith(".latex") ||
    lowerPath.endsWith(".bib")
  );
}

export function isPdfMimeType(mimeType: string | undefined): boolean {
  return mimeType === "application/pdf";
}

export function textPreviewKindForPath(pathValue: string): TextPreviewKind {
  if (isMarkdownPath(pathValue)) return "markdown";
  if (isLatexPath(pathValue)) return "latex";
  return null;
}

export function latexDocumentToMarkdown(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  const title = normalized.match(/\\title\{([^}]*)\}/)?.[1]?.trim();
  const author = normalized.match(/\\author\{([^}]*)\}/)?.[1]?.trim();
  const date = normalized.match(/\\date\{([^}]*)\}/)?.[1]?.trim();
  const documentMatch = normalized.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
  let body = documentMatch?.[1] ?? normalized;

  body = body
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\\(?:documentclass|usepackage)(?:\[[^\]]*\])?\{[^}]*\}/g, "")
    .replace(/\\title\{[^}]*\}/g, "")
    .replace(/\\author\{[^}]*\}/g, "")
    .replace(/\\date\{[^}]*\}/g, "")
    .replace(/\\(?:maketitle|tableofcontents|newpage|clearpage)\b/g, "")
    .replace(/\\section\*?\{([^}]*)\}/g, "\n# $1\n")
    .replace(/\\subsection\*?\{([^}]*)\}/g, "\n## $1\n")
    .replace(/\\subsubsection\*?\{([^}]*)\}/g, "\n### $1\n")
    .replace(/\\paragraph\*?\{([^}]*)\}/g, "\n#### $1\n")
    .replace(/\\textbf\{([^{}]*)\}/g, "**$1**")
    .replace(/\\(?:emph|textit)\{([^{}]*)\}/g, "*$1*")
    .replace(/\\texttt\{([^{}]*)\}/g, "`$1`")
    .replace(
      /\\begin\{(?:equation|align|gather)\*?\}([\s\S]*?)\\end\{(?:equation|align|gather)\*?\}/g,
      (_match, equation: string) => `\n$$\n${equation.trim()}\n$$\n`,
    )
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, equation: string) => `\n$$\n${equation.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, "$$$1$")
    .replace(/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g, (_match, list: string) =>
      list.replace(/\\item\s+/g, "- ").trim(),
    )
    .replace(/\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/g, (_match, list: string) => {
      let index = 0;
      return list
        .replace(/\\item\s+/g, () => {
          index += 1;
          return `${index}. `;
        })
        .trim();
    })
    .replace(/\\begin\{[^}]*\}|\\end\{[^}]*\}/g, "")
    .replace(/\\([#$%&_{}])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const headingParts = [title ? `# ${title}` : null, author, date].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  const preview = [...headingParts, body].filter((part) => part.length > 0).join("\n\n");
  return preview.length > 0 ? preview : source;
}
