import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet,
  type FileTreeIcons,
} from "@pierre/trees";

export interface PierreIconResolution {
  name: string;
  token?: string;
  viewBox?: string;
}

const PIERRE_ICON_SPRITE_ID = "zrode-pierre-file-icon-sprite";
let pierreIconSpriteContainer: HTMLElement | null = null;

/** Pierre's familiar file identities, with a quieter palette for Zrode. */
export const ZRODE_PIERRE_ICON_PALETTE = {
  gray: ["#7c8088", "#a4a8b0"],
  red: ["#a85f68", "#c9828a"],
  vermilion: ["#a76d5a", "#c68a76"],
  orange: ["#9c7354", "#c1916c"],
  yellow: ["#927b45", "#b7a065"],
  green: ["#5d806b", "#7fa18a"],
  teal: ["#4f7f80", "#74a1a2"],
  cyan: ["#4f7b91", "#7398aa"],
  blue: ["#55759a", "#7997ba"],
  indigo: ["#696b9b", "#8d8fba"],
  purple: ["#7b6796", "#9f88b8"],
  pink: ["#91677e", "#b6899e"],
  mauve: ["#756a78", "#9a8d9d"],
} as const;

type IconPaletteName = keyof typeof ZRODE_PIERRE_ICON_PALETTE;

const TOKEN_PALETTE: Partial<Record<string, IconPaletteName>> = {
  astro: "purple",
  babel: "yellow",
  bash: "green",
  biome: "blue",
  bootstrap: "indigo",
  browserslist: "yellow",
  bun: "mauve",
  c: "blue",
  claude: "orange",
  cpp: "blue",
  css: "indigo",
  database: "purple",
  docker: "blue",
  eslint: "indigo",
  font: "gray",
  git: "vermilion",
  go: "cyan",
  graphql: "pink",
  html: "orange",
  image: "pink",
  javascript: "yellow",
  json: "orange",
  markdown: "green",
  mcp: "teal",
  nextjs: "gray",
  npm: "red",
  oxc: "cyan",
  postcss: "red",
  prettier: "teal",
  python: "blue",
  react: "cyan",
  ruby: "red",
  rust: "orange",
  sass: "pink",
  stylelint: "gray",
  svelte: "red",
  svg: "orange",
  svgo: "green",
  swift: "orange",
  table: "teal",
  tailwind: "cyan",
  terraform: "indigo",
  text: "gray",
  typescript: "blue",
  vite: "purple",
  vscode: "blue",
  vue: "green",
  wasm: "indigo",
  webpack: "blue",
  yml: "red",
  zig: "orange",
  zip: "orange",
};

export function getZrodePierreIconColor(
  token: string | undefined,
  theme: "light" | "dark",
): string {
  const paletteName = (token && TOKEN_PALETTE[token]) || "gray";
  return ZRODE_PIERRE_ICON_PALETTE[paletteName][theme === "light" ? 0 : 1];
}

export const ZRODE_PIERRE_ICON_TREE_CSS = Object.entries(ZRODE_PIERRE_ICON_PALETTE)
  .map(([name, [light, dark]]) => `--trees-icon-${name}: light-dark(${light}, ${dark});`)
  .join("\n");

export const ZRODE_PIERRE_ICONS = {
  set: "complete",
  colored: true,
} satisfies FileTreeIcons;

const zrodeIconResolver = createFileTreeIconResolver(ZRODE_PIERRE_ICONS);

const LANGUAGE_EXTENSION_ALIASES: Record<string, string> = {
  bash: "sh",
  csharp: "cs",
  dockerfile: "dockerfile",
  javascript: "js",
  jsx: "jsx",
  markdown: "md",
  mdx: "mdx",
  plaintext: "txt",
  python: "py",
  ruby: "rb",
  rust: "rs",
  shell: "sh",
  shellscript: "sh",
  swift: "swift",
  typescript: "ts",
  tsx: "tsx",
  yaml: "yml",
};

/**
 * Conventional files which the Pierre resolver cannot distinguish from a
 * directory. Resolver-backed names (for example Dockerfile and .gitignore)
 * are intentionally not duplicated here.
 */
const KNOWN_EXTENSIONLESS_FILES = new Set([
  ".npmrc",
  ".nvmrc",
  ".yarnrc",
  "authors",
  "changelog",
  "codeowners",
  "contributors",
  "copying",
  "install",
  "jenkinsfile",
  "justfile",
  "license",
  "makefile",
  "news",
  "notice",
  "procfile",
  "taskfile",
  "tiltfile",
  "todo",
  "vagrantfile",
]);

export function basenameOfPath(pathValue: string): string {
  const slashIndex = pathValue.lastIndexOf("/");
  return slashIndex === -1 ? pathValue : pathValue.slice(slashIndex + 1);
}

export function inferEntryKindFromPath(pathValue: string): "file" | "directory" {
  if (pathValue.endsWith("/")) return "directory";
  const base = basenameOfPath(pathValue);
  if (KNOWN_EXTENSIONLESS_FILES.has(base.toLowerCase())) return "file";
  if (hasSpecificPierreIconForFileName(base)) return "file";
  if (base.startsWith(".") && !base.slice(1).includes(".")) return "directory";
  return base.includes(".") ? "file" : "directory";
}

export function syntheticFileNameForLanguageId(languageId: string): string {
  const normalized = languageId.toLowerCase();
  return `file.${LANGUAGE_EXTENSION_ALIASES[normalized] ?? normalized}`;
}

export function resolvePierreIconForEntry(
  pathValue: string,
  kind: "file" | "directory",
): PierreIconResolution | null {
  if (kind === "directory") return null;
  return zrodeIconResolver.resolveIcon("file-tree-icon-file", pathValue);
}

export function hasSpecificPierreIconForFileName(fileName: string): boolean {
  const icon = resolvePierreIconForEntry(fileName, "file");
  return icon !== null && icon.token !== "default";
}

export function ensurePierreIconSprite(): void {
  if (typeof document === "undefined") return;
  if (
    pierreIconSpriteContainer?.ownerDocument === document &&
    pierreIconSpriteContainer.isConnected
  ) {
    return;
  }
  const existing = document.getElementById(PIERRE_ICON_SPRITE_ID);
  if (existing) {
    pierreIconSpriteContainer = existing;
    return;
  }
  if (!document.body) return;
  const container = document.createElement("div");
  container.id = PIERRE_ICON_SPRITE_ID;
  container.setAttribute("aria-hidden", "true");
  container.style.position = "absolute";
  container.style.width = "0";
  container.style.height = "0";
  container.style.overflow = "hidden";
  container.style.pointerEvents = "none";
  container.innerHTML = getBuiltInSpriteSheet("complete");
  document.body.prepend(container);
  pierreIconSpriteContainer = container;
}
