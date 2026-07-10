import type { FileOptions } from "@pierre/diffs";
import type { WorkerRenderingOptions } from "@pierre/diffs/worker";

export type WorkspaceEditorResolvedTheme = "light" | "dark";

/** Workspace-only editor presentation; chat code blocks and diff views keep their themes. */
export const WORKSPACE_EDITOR_THEME_NAMES = {
  dark: "dark-plus",
  light: "light-plus",
} as const;

export const WORKSPACE_EDITOR_BACKGROUNDS = {
  dark: "#1e1e1e",
  light: "#ffffff",
} as const;

/**
 * Keep syntax highlighting available while editing generated files with long
 * lines. Pierre's default is 1,000 characters, which makes the edited line
 * fall back to plain text as soon as it crosses that boundary.
 */
export const WORKSPACE_TOKENIZE_MAX_LINE_LENGTH = 20_000;

export const WORKSPACE_EDITOR_RENDER_OPTIONS = {
  useTokenTransformer: true,
  tokenizeMaxLineLength: WORKSPACE_TOKENIZE_MAX_LINE_LENGTH,
} as const;

export function workspaceEditorTheme(theme: WorkspaceEditorResolvedTheme) {
  return WORKSPACE_EDITOR_THEME_NAMES[theme];
}

/**
 * The editable renderer must retain both theme slots. Pierre's initial Shiki
 * render can color tokens directly when given a single theme, but its
 * incremental editor writes `--diffs-token-light`/`--diffs-token-dark`
 * variables. Supplying both themes keeps the fallback variables defined, so
 * the initial and incremental render paths resolve colors the same way.
 */
export function workspaceEditableEditorRenderOptions(
  theme: WorkspaceEditorResolvedTheme,
): Pick<
  FileOptions<unknown>,
  "theme" | "themeType" | "tokenizeMaxLineLength" | "useTokenTransformer"
> {
  return {
    ...WORKSPACE_EDITOR_RENDER_OPTIONS,
    theme: WORKSPACE_EDITOR_THEME_NAMES,
    themeType: theme,
  };
}

export function workspaceEditorBackground(theme: WorkspaceEditorResolvedTheme) {
  return WORKSPACE_EDITOR_BACKGROUNDS[theme];
}

export function workspaceEditorRenderOptions(
  theme: WorkspaceEditorResolvedTheme,
): Pick<WorkerRenderingOptions, "theme" | "tokenizeMaxLineLength" | "useTokenTransformer"> {
  return {
    ...WORKSPACE_EDITOR_RENDER_OPTIONS,
    theme: workspaceEditorTheme(theme),
  };
}

export function hasWorkspaceEditorRenderOptions(
  current: Pick<WorkerRenderingOptions, "theme" | "tokenizeMaxLineLength" | "useTokenTransformer">,
  theme: WorkspaceEditorResolvedTheme,
): boolean {
  const expected = workspaceEditorRenderOptions(theme);
  return (
    current.theme === expected.theme &&
    current.tokenizeMaxLineLength === expected.tokenizeMaxLineLength &&
    current.useTokenTransformer === expected.useTokenTransformer
  );
}

export const WORKSPACE_EDITOR_UNSAFE_CSS = `
  :host {
    --diffs-font-family: Menlo, Monaco, Consolas, "Courier New", monospace;
    --diffs-font-size: 13px;
    --diffs-line-height: 20px;
    --diffs-line-bg: transparent;
  }

  :host,
  [data-file],
  [data-code],
  [data-content],
  pre {
    background-color: transparent !important;
  }

  /* The number gutter is sticky while code scrolls underneath it. Keep that
     layer opaque, but leave content transparent so editor/search decorations
     remain visible against the unified outer surface. */
  [data-gutter] {
    background-color: var(--workspace-editor-background) !important;
  }
`;
